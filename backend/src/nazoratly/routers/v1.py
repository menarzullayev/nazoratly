"""Aggregates all /v1 routers."""

from __future__ import annotations

from fastapi import APIRouter

from nazoratly.routers import (
    academics,
    agents,
    auth,
    documents,
    entitlements,
    finance,
    leads,
    lessons,
    lifecycle,
    org,
    packages,
    pay,
    payroll,
    plans,
    settings,
    students,
)

router = APIRouter()
router.include_router(auth.router)
router.include_router(org.router)
router.include_router(students.router)
router.include_router(academics.router)
router.include_router(lifecycle.router)
router.include_router(entitlements.router)
router.include_router(leads.router)
router.include_router(settings.router)
router.include_router(lessons.router)
router.include_router(finance.router)
router.include_router(plans.router)
router.include_router(packages.router)
router.include_router(documents.router)
router.include_router(payroll.router)
router.include_router(agents.router)
router.include_router(pay.settings_router)
