import { SiteHome } from "@/components/SiteHome";
import { metadataFor } from "@/i18n/metadata";

export const metadata = metadataFor("uz");

export default function Page() {
  return <SiteHome locale="uz" />;
}
