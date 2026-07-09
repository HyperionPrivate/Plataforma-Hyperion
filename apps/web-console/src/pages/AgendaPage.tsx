import { Layout } from "../components/Layout.js";
import { EmptyState } from "../components/ui.js";

export function AgendaPage() {
  return (
    <Layout title="Agenda de citas">
      <EmptyState label="En construccion" />
    </Layout>
  );
}
