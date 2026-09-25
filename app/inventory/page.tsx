import type { Metadata } from "next";
import { getOpportunitiesForPage, uniqueValues } from "@/lib/inventory";
import { InventoryBrowser } from "@/components/InventoryBrowser";
import { UT_INVENTORY_URL } from "@/lib/config";

export const revalidate = 900;

export const metadata: Metadata = {
  title: "Raw Opportunity Bank",
  description:
    "Browse every AI opportunity submitted to the inventory — searchable by societal domain, deployment stage, and organization type.",
};

export default async function InventoryPage() {
  // null only if the backend was down during the build.
  const opportunities = await getOpportunitiesForPage();
  const loadError = opportunities === null;

  return (
    <div className="mx-auto w-full max-w-6xl px-5 py-12 sm:py-16">
      <p className="label mb-4 text-accent">The Raw Opportunity Bank</p>
      <h1 className="max-w-3xl font-serif text-4xl leading-tight tracking-tight sm:text-5xl">
        Every submission, as submitted.
      </h1>
      <p className="mt-4 max-w-2xl leading-relaxed text-ink-soft">
        Transparency is a core principle of the inventory: every entry appears here
        exactly as it came in — no editing, no filtering — so researchers and
        organizations can assess the landscape for themselves. Entries are community
        submissions and are not endorsements. Read more about the process at{" "}
        <a
          href={UT_INVENTORY_URL}
          className="text-accent underline underline-offset-2 hover:text-accent-deep"
          target="_blank"
          rel="noopener noreferrer"
        >
          Texas Law
        </a>
        .
      </p>

      {loadError ? (
        <div className="mt-12 border border-rule bg-paper-sunken p-8 text-center">
          <p className="font-serif text-2xl">The bank is momentarily unreachable.</p>
          <p className="mt-2 text-sm text-ink-soft">
            Please check back in a little while — the underlying database did not respond.
          </p>
        </div>
      ) : (
        <InventoryBrowser
          opportunities={opportunities}
          domains={uniqueValues(opportunities, "domain")}
          stages={uniqueValues(opportunities, "deploymentStage")}
          orgTypes={uniqueValues(opportunities, "orgType")}
        />
      )}
    </div>
  );
}
