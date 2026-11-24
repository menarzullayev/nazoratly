"""Aggregates all /v1 routers."""

from __future__ import annotations

from fastapi import APIRouter

from nazoratly.routers import (
    academics,
    accounting,
    agents,
    ai,
    auth,
    branches,
    cashclose,
    certificates,
    dashboard,
    demo,
    discounts,
    documents,
    entitlements,
    finance,
    growth,
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
    progress,
    qr,
    reconciliation,
    refunds,
    results,
    schedule,
    settings,
    students,
    teacher_admin,
    teacher_auth,
    teacher_me,
    waitlist,
)

router = APIRouter()
router.include_router(auth.router)
router.include_router(org.router)
router.include_router(branches.router)
router.include_router(students.router)
router.include_router(academics.router)
router.include_router(lifecycle.router)
router.include_router(entitlements.router)
router.include_router(waitlist.router)
router.include_router(qr.router)
router.include_router(imports.router)
router.include_router(demo.router)
router.include_router(growth.router)  # before leads: /leads/reminders must not match /leads/{lead_id}
router.include_router(leads.router)
router.include_router(settings.router)
router.include_router(
    teacher_admin.router
)  # before lessons: /lessons/unmarked must not match /lessons/{lesson_id}
router.include_router(lessons.router)
router.include_router(schedule.router)
router.include_router(finance.router)
router.include_router(discounts.router)
router.include_router(refunds.router)
router.include_router(cashclose.router)
router.include_router(plans.router)
router.include_router(packages.router)
router.include_router(dashboard.router)
router.include_router(documents.router)
router.include_router(results.router)
router.include_router(progress.router)
router.include_router(certificates.router)
router.include_router(payroll.router)
router.include_router(accounting.router)
router.include_router(payables.router)
router.include_router(reconciliation.router)
router.include_router(agents.router)
router.include_router(ai.router)
router.include_router(teacher_auth.router)
router.include_router(teacher_me.router)
router.include_router(pay.settings_router)
