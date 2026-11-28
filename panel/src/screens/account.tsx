import { useNavigate } from "react-router";
import { api, unwrap } from "../api/client";
import { useI18n } from "../i18n";
import { session } from "../session/browser";
import { useSession, useStaff } from "../session/context";
import { Form, type Field } from "../ui/form";
import { Card, Facts, Page } from "../ui/kit";
import { CenterList } from "./auth";

export function AccountPage() {
  const { t, label } = useI18n();
  const { me, org } = useStaff();
  const { logout, reload } = useSession();
  const navigate = useNavigate();
  const fields: Field[] = [
    { name: "current_password", label: t("auth.currentPassword"), type: "password", required: true, maxLength: 128, autoComplete: "current-password" },
    { name: "new_password", label: t("auth.newPassword"), type: "password", required: true, minLength: 10, maxLength: 128, autoComplete: "new-password", hint: t("auth.passwordHint") },
  ];
  return (
    <Page title={t("nav.account")}>
      <Card title={me.full_name}>
        <Facts
          items={[
            [t("common.email"), me.email],
            [t("common.phone"), me.phone],
            [t("staff.role"), label("role", org.role)],
          ]}
        />
        <p>
          <button type="button" onClick={() => void logout().then(() => navigate("/login"))}>
            {t("auth.signOut")}
          </button>
        </p>
      </Card>
      <Card title={t("center.title")}>
        <CenterList onEntered={() => navigate("/")} />
      </Card>
      <Card title={t("account.password")}>
        <p className="hint">{t("account.passwordWarning")}</p>
        <Form
          fields={fields}
          submitLabel={t("account.changePassword")}
          submit={async (body) => {
            await unwrap(
              api.POST("/v1/auth/password", { body: { current_password: String(body.current_password), new_password: String(body.new_password) } }),
            );
            session.forget();
            navigate("/login");
            await reload();
          }}
        />
      </Card>
    </Page>
  );
}
