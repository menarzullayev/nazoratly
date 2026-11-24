"""Role -> permission matrix (application-level RBAC; the database's RLS is the second, tenant-level layer)."""

from __future__ import annotations

from typing import Final

ALL: Final = frozenset(
    {
        "org:read", "org:manage",
        "staff:read", "staff:manage",
        "students:read", "students:write", "consents:write",
        "academics:read", "academics:write",
        "attendance:read", "attendance:write",
        "finance:read", "finance:write", "expenses:write",
        "payroll:read", "payroll:write", "payroll:approve",
        "reports:read", "audit:read",
        "accounting:read", "accounting:write", "accounting:close",
        "agent:manage",
        "results:read", "results:write", "results:approve",
        "branches:manage",
    }
)  # fmt: skip

_MANAGER: Final = frozenset(
    {
        "org:read", "students:read", "students:write", "consents:write", "academics:read", "academics:write",
        "attendance:read", "attendance:write", "finance:read", "finance:write", "reports:read", "staff:read",
        "accounting:read", "results:read", "results:write", "results:approve",
    }
)  # fmt: skip

_ACCOUNTANT: Final = frozenset(
    {
        "org:read", "students:read", "academics:read", "attendance:read", "finance:read", "finance:write",
        "expenses:write", "payroll:read", "payroll:write", "reports:read", "accounting:read", "accounting:write",
    }
)  # fmt: skip

_TEACHER: Final = frozenset(
    {"org:read", "academics:read", "attendance:read", "attendance:write", "results:read", "results:write"}
)

_VIEWER: Final = frozenset(
    {"org:read", "students:read", "academics:read", "attendance:read", "reports:read", "results:read"}
)

ROLE_PERMISSIONS: Final[dict[str, frozenset[str]]] = {
    "owner": ALL,
    "admin": ALL
    - {"org:manage"},  # branches:manage still needs center-wide staff (no branch on the membership)
    "manager": _MANAGER,
    "accountant": _ACCOUNTANT,
    "teacher": _TEACHER,
    "viewer": _VIEWER,
}

ROLES: Final = tuple(ROLE_PERMISSIONS)


def permissions_for(role: str) -> frozenset[str]:
    return ROLE_PERMISSIONS.get(role, frozenset())
