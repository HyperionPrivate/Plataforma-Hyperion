import { SideNav } from "@/components/layout/side-nav";

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen bg-[var(--bg)] text-[var(--text)]">
      <div className="sticky top-0 hidden h-screen md:block">
        <SideNav />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex-1 p-[var(--page-padding)]">{children}</main>
        <footer className="border-t border-[var(--border)] py-3 text-center text-[10px] tracking-[0.2em] text-[var(--muted)]">
          HYPERION ONE · Applied Intelligence
        </footer>
      </div>
    </div>
  );
}
