"""Aggregates all /v1 routers."""

from __future__ import annotations

from fastapi import APIRouter

from nazoratly.routers import (
    academics,
    accounting,
    agents,
    ai,
    auth,
    dashboard,
    demo,
    documents,
    entitlements,
    finance,
    imports,
    leads,
    lessons,
    lifecycle,
    org,
    packages,
    pay,
    payables,
    payroll,
    plans,
    qr,
    reconciliation,
    schedule,
    settings,
    students,
    waitlist,
)

router = APIRouter()
router.include_router(auth.router)
router.include_router(org.router)
router.include_router(students.router)
router.include_router(academics.router)
router.include_router(lifecycle.router)
router.include_router(entitlements.router)
router.include_router(waitlist.router)
router.include_router(qr.router)
router.include_router(imports.router)
router.include_router(demo.router)
router.include_router(leads.router)
router.include_router(settings.router)
router.include_router(lessons.router)
router.include_router(schedule.router)
router.include_router(finance.router)
router.include_router(plans.router)
router.include_router(packages.router)
router.include_router(dashboard.router)
router.include_router(documents.router)
router.include_router(payroll.router)
router.include_router(accounting.router)
router.include_router(payables.router)
router.include_router(reconciliation.router)
router.include_router(agents.router)
router.include_router(ai.router)
router.include_router(pay.settings_router)
