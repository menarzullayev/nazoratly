"""Shared API models."""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, StringConstraints

Dec2 = Annotated[
    Decimal,
    PlainSerializer(lambda v: format(v.quantize(Decimal("0.01")), "f"), return_type=str, when_used="json"),
]  # output money: always two decimals
Money = Annotated[Decimal, Field(max_digits=14, decimal_places=2, ge=0, description="UZS amount, 2 decimals")]
PositiveMoney = Annotated[
    Decimal, Field(max_digits=14, decimal_places=2, gt=0, description="UZS amount, 2 decimals")
]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
LongText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=4000)]
Phone = Annotated[
    str, StringConstraints(pattern=r"^\+[1-9][0-9]{7,14}$"), Field(description="E.164, e.g. +998901234567")
]


class Model(BaseModel):
    model_config = ConfigDict(from_attributes=True, extra="forbid", str_strip_whitespace=True)


class Out(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class Page[T](Out):
    items: list[T]
    limit: int
    offset: int
    has_more: bool


def make_page[T: BaseModel](rows: list[dict[str, Any]], limit: int, offset: int, model: type[T]) -> Page[T]:
    """`rows` was fetched with LIMIT limit+1 so that has_more costs no COUNT(*)."""
    items = [model.model_validate(r) for r in rows[:limit]]
    return Page[T](items=items, limit=limit, offset=offset, has_more=len(rows) > limit)


class Message(Out):
    message: str
