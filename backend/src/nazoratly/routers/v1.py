"""Aggregates all /v1 routers."""

from __future__ import annotations

from fastapi import APIRouter

from nazoratly.routers import academics, agents, auth, finance, lessons, org, pay, payroll, students

router = APIRouter()
router.include_router(auth.router)
router.include_router(org.router)
router.include_router(students.router)
router.include_router(academics.router)
router.include_router(lessons.router)
router.include_router(finance.router)
router.include_router(payroll.router)
router.include_router(agents.router)
router.include_router(pay.settings_router)
