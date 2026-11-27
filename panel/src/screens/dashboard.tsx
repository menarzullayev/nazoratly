import { Link } from "react-router";
import { api, unwrap } from "../api/client";
import { useI18n } from "../i18n";
import { formatAmount, formatDate, formatMonth } from "../lib/format";
import { useStaff } from "../session/context";
import { useLoad } from "../ui/hooks";
import { Card, Facts, Loaded, Page, Table } from "../ui/kit";

export function DashboardPage() {
  const { t, label } = useI18n();
  const { can } = useStaff();
  const load = useLoad(() => unwrap(api.GET("/v1/dashboard")), []);
  const student = (id: string, name: string) => (can("students:read") ? <Link to={`/students/${id}`}>{name}</Link> : <span>{name}</span>);
  return (
    <Page title={t("nav.dashboard")}>
      <Loaded load={load}>
        {(d) => (
          <>
            <p className="muted">{t("dashboard.range", { from: formatDate(d.range.date_from), to: formatDate(d.range.date_to) })}</p>
            <div className="grid">
              <Card title={t("dashboard.money")}>
                <Facts
                  items={[
                    [t("dashboard.income"), formatAmount(d.finance.income)],
                    [t("dashboard.expenses"), formatAmount(d.finance.expenses)],
                    [t("dashboard.net"), formatAmount(d.finance.net)],
                  ]}
                />
              </Card>
              <Card title={t("dashboard.payments")}>
                <Facts
                  items={[
                    [t("dashboard.paid"), d.payments.paid],
                    [t("dashboard.unpaid"), d.payments.unpaid],
                    [t("dashboard.overdue"), d.payments.overdue],
                  ]}
                />
              </Card>
              <Card title={t("dashboard.movement")}>
                <Facts
                  items={[
                    [t("dashboard.new"), d.movement.new],
                    [t("dashboard.left"), d.movement.left],
                    [t("dashboard.trials"), d.movement.trials_started],
                    [t("dashboard.accepted"), d.movement.accepted],
                    [t("dashboard.dropped"), d.movement.dropped],
                    [t("dashboard.running"), d.movement.running],
                    [t("dashboard.conversion"), `${d.movement.conversion}%`],
                  ]}
                />
              </Card>
              <Card title={t("dashboard.funnel")}>
                <Facts items={Object.entries(d.funnel.stages as Record<string, number>).map(([k, v]) => [label("leadStage", k), v])} />
              </Card>
            </div>
            <Card title={t("dashboard.months")}>
              <Table
                caption={t("dashboard.months")}
                rows={d.finance.months}
                rowKey={(m) => m.month}
                columns={[
                  { head: t("common.month"), cell: (m) => formatMonth(m.month) },
                  { head: t("dashboard.income"), cell: (m) => formatAmount(m.income), className: "num" },
                  { head: t("dashboard.expenses"), cell: (m) => formatAmount(m.expenses), className: "num" },
                  { head: t("dashboard.payroll"), cell: (m) => formatAmount(m.payroll), className: "num" },
                  { head: t("dashboard.net"), cell: (m) => formatAmount(m.net), className: "num" },
                ]}
              />
            </Card>
            <Card title={t("dashboard.unpaidList")}>
              <Table
                caption={t("dashboard.unpaidList")}
                rows={d.payments.unpaid_students}
                rowKey={(s) => s.id}
                columns={[
                  { head: t("common.student"), cell: (s) => student(s.id, s.name) },
                  { head: t("finance.outstanding"), cell: (s) => formatAmount(s.outstanding), className: "num" },
                  { head: t("finance.overdue"), cell: (s) => formatAmount(s.overdue), className: "num" },
                ]}
              />
            </Card>
            <Card title={t("dashboard.paidList")}>
              <Table caption={t("dashboard.paidList")} rows={d.payments.paid_students} rowKey={(s) => s.id} columns={[{ head: t("common.student"), cell: (s) => student(s.id, s.name) }]} />
            </Card>
            <div className="grid">
              <Card title={t("dashboard.newList")}>
                <Table caption={t("dashboard.newList")} rows={d.movement.new_students} rowKey={(s) => s.id} columns={[{ head: t("common.student"), cell: (s) => student(s.id, s.name) }]} />
              </Card>
              <Card title={t("dashboard.leftList")}>
                <Table caption={t("dashboard.leftList")} rows={d.movement.left_students} rowKey={(s) => s.id} columns={[{ head: t("common.student"), cell: (s) => student(s.id, s.name) }]} />
              </Card>
            </div>
            <Card title={t("dashboard.waiting", { n: d.waiting.total })}>
              <Table
                caption={t("dashboard.waitingTrials")}
                empty={t("dashboard.noTrials")}
                rows={d.waiting.trials}
                rowKey={(w) => w.enrollment_id}
                columns={[
                  { head: t("dashboard.waitingTrials"), cell: (w) => student(w.student_id, w.student_name) },
                  { head: t("common.group"), cell: (w) => w.group_name },
                  { head: t("dashboard.lessonsAttended"), cell: (w) => w.lessons_attended },
                ]}
              />
              <Table
                caption={t("dashboard.waitingRights")}
                empty={t("dashboard.noRights")}
                rows={d.waiting.rights}
                rowKey={(w) => w.id}
                columns={[
                  { head: t("dashboard.waitingRights"), cell: (w) => student(w.student_id, w.student_name) },
                  { head: t("common.group"), cell: (w) => w.group_name },
                  { head: t("dashboard.daysLeft"), cell: (w) => w.days_left },
                ]}
              />
              <Table
                caption={t("dashboard.waitingPackages")}
                empty={t("dashboard.noPackages")}
                rows={d.waiting.packages}
                rowKey={(w) => w.enrollment_id}
                columns={[
                  { head: t("dashboard.waitingPackages"), cell: (w) => student(w.student_id, w.student_name) },
                  { head: t("common.group"), cell: (w) => w.group_name },
                  { head: t("dashboard.daysLeft"), cell: (w) => w.days_left },
                ]}
              />
              <Table
                caption={t("dashboard.waitingSeats")}
                empty={t("dashboard.noSeats")}
                rows={d.waiting.seats}
                rowKey={(w) => w.entry_id}
                columns={[
                  { head: t("dashboard.waitingSeats"), cell: (w) => student(w.student_id, w.student_name) },
                  { head: t("common.group"), cell: (w) => w.group_name },
                  { head: t("dashboard.freeSeats"), cell: (w) => w.free_seats },
                ]}
              />
            </Card>
          </>
        )}
      </Loaded>
    </Page>
  );
}
