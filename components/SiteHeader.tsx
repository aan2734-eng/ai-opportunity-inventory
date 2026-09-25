import Link from "next/link";
import { INTEREST_FORM_URL } from "@/lib/config";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-rule bg-paper/95 backdrop-blur-sm">
      <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-4 px-5">
        <Link href="/" className="flex items-baseline gap-2.5 group">
          <span className="label text-accent">AOI</span>
          <span className="font-serif text-lg leading-none tracking-tight group-hover:text-accent-deep transition-colors">
            AI Opportunity Inventory
          </span>
        </Link>
        <nav className="flex items-center gap-1 sm:gap-2">
          <Link
            href="/inventory"
            className="label px-2.5 py-2 text-ink-soft hover:text-accent transition-colors"
          >
            Inventory
          </Link>
          <Link
            href="/assistant"
            className="label px-2.5 py-2 text-ink-soft hover:text-accent transition-colors"
          >
            Assistant
          </Link>
          <Link
            href="https://oppinventory.blog/"
            className="label px-2.5 py-2 text-ink-soft hover:text-accent transition-colors"
          >
            Memos
          </Link>
          <a
            href={INTEREST_FORM_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="label ml-1 hidden border border-rule-strong px-3.5 py-2 text-ink hover:bg-ink hover:text-paper transition-colors sm:block"
          >
            Join →
          </a>
        </nav>
      </div>
    </header>
  );
}
