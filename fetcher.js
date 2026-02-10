import { extractFromHtml } from "./extractor.js";

const SNAPSHOT_GQL = "https://hub.snapshot.org/graphql";
const TALLY_GQL = "https://api.tally.xyz/query";

// -------------------- Snapshot helpers --------------------
function parseSnapshotUrl(url) {
  const u = new URL(url);
  const hash = (u.hash || "").replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);

  const proposalIndex = parts.findIndex((p) => p === "proposal");
  if (proposalIndex === -1 || !parts[proposalIndex + 1]) return null;

  const proposalId = parts[proposalIndex + 1];
  const maybeSpace = parts[0] || null;

  return { proposalId, maybeSpace };
}

async function fetchSnapshotProposal(proposalId) {
  const query = `
    query Proposal($id: String!) {
      proposal(id: $id) {
        id
        title
        body
        choices
        start
        end
        state
        author
        type
        quorum
        scores
        scores_total
        scores_updated
        space { id name }
      }
    }
  `;

  const res = await fetch(SNAPSHOT_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "gov-ai-demo/1.0",
    },
    body: JSON.stringify({ query, variables: { id: proposalId } }),
  });

  if (!res.ok) throw new Error(`Snapshot GraphQL error: HTTP ${res.status}`);

  const data = await res.json();
  const proposal = data?.data?.proposal;
  if (!proposal) throw new Error("Snapshot proposal not found (GraphQL returned null).");

  return proposal;
}

// -------------------- Tally helpers --------------------
// URL example: https://www.tally.xyz/gov/uniswap/proposal/83
function parseTallyUrl(url) {
  const u = new URL(url);
  const hostOk = u.hostname === "www.tally.xyz" || u.hostname === "tally.xyz";
  if (!hostOk) return null;

  const parts = u.pathname.split("/").filter(Boolean);
  // expected: ["gov", "<slug>", "proposal", "<onchainId>"]
  if (parts.length < 4) return null;
  if (parts[0] !== "gov") return null;
  if (parts[2] !== "proposal") return null;

  const slug = parts[1];
  const onchainId = parts[3]; // usually "83" (string)
  if (!slug || !onchainId) return null;

  return { slug, onchainId };
}

async function tallyGql(query, variables, apiKey) {
  const res = await fetch(TALLY_GQL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "gov-ai-demo/1.0",
      // Official header is Api-Key :contentReference[oaicite:1]{index=1}
      "Api-Key": apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Tally GraphQL error: HTTP ${res.status} ${t ? `- ${t.slice(0, 200)}` : ""}`);
  }

  const data = await res.json();
  if (data?.errors?.length) {
    throw new Error(`Tally GraphQL returned errors: ${data.errors[0]?.message || "unknown"}`);
  }
  return data?.data;
}

async function fetchTallyGovernorIdBySlug(slug, apiKey) {
  // Official docs: governor can be fetched by ID or slug :contentReference[oaicite:2]{index=2}
  const query = `
    query Governor($input: GovernorInput!) {
      governor(input: $input) {
        id
        slug
        name
        chainId
        organization { id slug name }
      }
    }
  `;

  const data = await tallyGql(query, { input: { slug } }, apiKey);
  const g = data?.governor;
  if (!g?.id) throw new Error("Tally governor not found for slug: " + slug);
  return g;
}

async function fetchTallyOrganizationBySlug(slug, apiKey) {
  const query = `
    query Organization($input: OrganizationInput!) {
      organization(input: $input) {
        id
        slug
        name
      }
    }
  `;

  const data = await tallyGql(query, { input: { slug } }, apiKey);
  const org = data?.organization;
  if (!org?.id) throw new Error("Tally organization not found for slug: " + slug);
  return org;
}

async function fetchTallyPrimaryGovernorByOrganizationId(organizationId, apiKey) {
  const query = `
    query Governors($input: GovernorsInput!) {
      governors(input: $input) {
        nodes {
          ... on Governor {
            id
            slug
            name
            chainId
            isPrimary
            organization { id slug name }
          }
        }
      }
    }
  `;

  const data = await tallyGql(
    query,
    {
      input: {
        filters: { organizationId, includeInactive: true, excludeSecondary: true },
        page: { limit: 50 }
      }
    },
    apiKey
  );

  const nodes = Array.isArray(data?.governors?.nodes) ? data.governors.nodes : [];
  const governors = nodes.filter((n) => n && typeof n === "object" && n.id && n.slug);

  if (!governors.length) {
    throw new Error("Tally governors not found for organizationId: " + organizationId);
  }

  const primary = governors.find((g) => g.isPrimary) || governors[0];
  return primary;
}

async function resolveTallyGovernorFromGovPathSlug(pathSlug, apiKey) {
  // First try: treat /gov/<slug>/ as a governor slug.
  try {
    return await fetchTallyGovernorIdBySlug(pathSlug, apiKey);
  } catch (e) {
    const msg = String(e?.message || e || "");
    const isNotFound =
      msg.toLowerCase().includes("governor not found") ||
      msg.toLowerCase().includes("not found for slug");

    if (!isNotFound) throw e;

    // Fallback: treat /gov/<slug>/ as an organization slug.
    const org = await fetchTallyOrganizationBySlug(pathSlug, apiKey);
    return await fetchTallyPrimaryGovernorByOrganizationId(org.id, apiKey);
  }
}

async function fetchTallyProposal(governorId, onchainId, apiKey) {
  // Official docs: proposal can be fetched by ID OR (onchainId + governorId) :contentReference[oaicite:3]{index=3}
  const query = `
    query Proposal($input: ProposalInput!) {
      proposal(input: $input) {
        id
        onchainId
        status
        quorum
        metadata { title description discourseURL snapshotURL txHash ipfsHash }
        start { ... on Block { number timestamp } ... on BlocklessTimestamp { timestamp } }
        end   { ... on Block { number timestamp } ... on BlocklessTimestamp { timestamp } }
        governor { id slug name chainId }
        organization { id slug name }
        voteStats { type votesCount votersCount percent }
        executableCalls { target signature calldata value }
      }
    }
  `;

  const data = await tallyGql(
    query,
    { input: { governorId, onchainId: String(onchainId) } },
    apiKey
  );

  const p = data?.proposal;
  if (!p?.id) throw new Error("Tally proposal not found for governorId+onchainId");
  return p;
}

function normalizeTallyToExtracted(tallyGovernor, tallyProposal) {
  const title = tallyProposal?.metadata?.title || "UNKNOWN";
  const body = tallyProposal?.metadata?.description || "";
  // Tally voteStats is per vote type; for normal “For/Against/Abstain” you’ll see types
  const voteStats = Array.isArray(tallyProposal?.voteStats) ? tallyProposal.voteStats : [];

  // We store "options" in a stable user-facing way.
// Tally voteStats may include internal "pending*" types; those are NOT voting options.
// Normalize to uppercase FOR/AGAINST/ABSTAIN and keep a stable order.
  const normalizeVoteType = (t) => {
    const s = String(t || "").toLowerCase();
    if (s === "for") return "FOR";
    if (s === "against") return "AGAINST";
    if (s === "abstain") return "ABSTAIN";
    return null;
  };

  const present = new Set();
  for (const v of voteStats) {
    const vt = normalizeVoteType(v?.type);
    if (vt) present.add(vt);
  }

  const preferredOrder = ["FOR", "AGAINST", "ABSTAIN"];
  const options = preferredOrder.filter((o) => present.has(o));

  return {
    source_type: "tally",
    fetched_at: new Date().toISOString(),
    title,
    body,
    options,
    current_results: voteStats.length
      ? { voteStats }
      : null,
    metadata: {
      governor_id: tallyGovernor?.id ?? null,
      governor_slug: tallyGovernor?.slug ?? null,
      governor_name: tallyGovernor?.name ?? null,
      chain_id: tallyGovernor?.chainId ?? tallyProposal?.governor?.chainId ?? null,
      organization_slug: tallyGovernor?.organization?.slug ?? tallyProposal?.organization?.slug ?? null,
      organization_name: tallyGovernor?.organization?.name ?? tallyProposal?.organization?.name ?? null,
      proposal_id: tallyProposal?.id ?? null,
      onchain_id: tallyProposal?.onchainId ?? null,
      status: tallyProposal?.status ?? null,
      quorum: tallyProposal?.quorum ?? null,
      discourse_url: tallyProposal?.metadata?.discourseURL ?? null,
      snapshot_url: tallyProposal?.metadata?.snapshotURL ?? null,
      tx_hash: tallyProposal?.metadata?.txHash ?? null,
      ipfs_hash: tallyProposal?.metadata?.ipfsHash ?? null,
      executable_calls_count: Array.isArray(tallyProposal?.executableCalls)
        ? tallyProposal.executableCalls.length
        : 0,
    },
  };
}

// -------------------- main --------------------
export async function fetchAndExtract(url) {
  // 1) Snapshot fast-path via GraphQL (SPA-safe)
  try {
    const parsed = parseSnapshotUrl(url);
    if (parsed && new URL(url).hostname.includes("snapshot.org")) {
      const p = await fetchSnapshotProposal(parsed.proposalId);

      return {
        source_type: "snapshot",
        fetched_at: new Date().toISOString(),
        title: p.title || "UNKNOWN",
        body: p.body || "",
        options: Array.isArray(p.choices) ? p.choices : [],
        current_results: Array.isArray(p.scores) && p.scores.length > 0
          ? {
              scores: p.scores,
              scores_total: p.scores_total ?? null,
              scores_updated: p.scores_updated ?? null,
              state: p.state ?? null,
            }
          : null,
        metadata: {
          proposal_id: p.id,
          space_id: p.space?.id ?? null,
          space_name: p.space?.name ?? null,
          author: p.author ?? null,
          start: p.start ?? null,
          end: p.end ?? null,
          state: p.state ?? null,
          type: p.type ?? null,
          quorum: p.quorum ?? null,
        },
      };
    }
  } catch (e) {
    // fallback дальше
  }

  // 2) Tally fast-path via official GraphQL API (SPA-safe)
  try {
    const parsed = parseTallyUrl(url);
    const apiKey = process.env.TALLY_API_KEY;
    if (parsed && apiKey) {
      const g = await resolveTallyGovernorFromGovPathSlug(parsed.slug, apiKey);
      const p = await fetchTallyProposal(g.id, parsed.onchainId, apiKey);
      return normalizeTallyToExtracted(g, p);
    }
} catch (e) {
  console.error("[tally] fast-path failed:", {
    message: e?.message || String(e),
    url,
  });
}

  // 3) Generic HTML fallback
  const res = await fetch(url, {
    headers: { "User-Agent": "gov-ai-demo/1.0" },
  });

  if (!res.ok) throw new Error("Failed to fetch URL: " + res.status);

  const html = await res.text();
  const extracted = extractFromHtml(html);

const u = new URL(url);

let sourceType = "generic";

// If it's daodao.zone, mark as daodao
// (even though we still use the generic HTML fetch, the extractor may pull __NEXT_DATA__ from the HTML)
if (u.hostname === "daodao.zone" || u.hostname.endsWith(".daodao.zone")) {
  sourceType = "daodao";
}

return {
  source_type: sourceType,
  fetched_at: new Date().toISOString(),
  ...extracted
};

}
