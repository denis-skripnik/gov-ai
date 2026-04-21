export function extractFirstUrl(text) {
  const match = String(text || "").match(/https?:\/\/\S+/i);
  return match ? match[0].trim() : null;
}

export function validateProposalUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false, reason: "That does not look like a valid URL." };
  }

  const host = parsed.hostname.toLowerCase();
  const pathname = parsed.pathname;

  if (host === "snapshot.org") {
    if (/^#\/s:[^/]+\/proposal\/.+/i.test(parsed.hash)) {
      return { ok: true, sourceType: "snapshot", normalizedUrl: parsed.toString() };
    }
    return { ok: false, reason: "Snapshot URL format is not recognized as a proposal link." };
  }

  if (host === "daodao.zone") {
    if (/^\/dao\/[^/]+\/proposals\/[^/]+/i.test(pathname)) {
      return { ok: true, sourceType: "daodao", normalizedUrl: parsed.toString() };
    }
    return { ok: false, reason: "DAO DAO URL format is not recognized as a proposal link." };
  }

  if (host === "www.tally.xyz" || host === "tally.xyz") {
    if (/^\/gov\/[^/]+\/proposal\/[^/]+/i.test(pathname)) {
      return { ok: true, sourceType: "tally", normalizedUrl: parsed.toString() };
    }
    return { ok: false, reason: "Tally URL format is not recognized as a proposal link." };
  }

  if (host === "www.mintscan.io" || host === "mintscan.io") {
    if (/^\/[^/]+\/proposals\/[^/]+/i.test(pathname)) {
      return { ok: true, sourceType: "mintscan", normalizedUrl: parsed.toString() };
    }
    return { ok: false, reason: "Mintscan URL format is not recognized as a proposal link." };
  }

  return {
    ok: false,
    reason: "Unsupported proposal source. Right now I support Snapshot, DAO DAO, Tally, and Mintscan proposal links.",
  };
}
