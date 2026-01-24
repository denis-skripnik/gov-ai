export function extractFromHtml(html) {
  // 1) Try Next.js __NEXT_DATA__ fast-path (e.g., daodao.zone)
  // If it fails for any reason, fall back to the old naive extractor.
  const next = tryExtractFromNextData(html);
  if (next) return next;

  // 2) OLD naive fallback extractor: demo only
  // Removes tags and takes first parts of text
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "UNKNOWN";

  const body = text.slice(0, 5000);

  return {
    title,
    body,
    options: [],
    current_results: null,
    metadata: {}
  };
}

function tryExtractFromNextData(html) {
  // Look for: <script id="__NEXT_DATA__" type="application/json"> ... </script>
  const m = html.match(
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!m || !m[1]) return null;

  const jsonText = m[1].trim();
  if (!jsonText) return null;

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return null;
  }

  // Common Next.js location:
  // data.props.pageProps ...
  const pageProps = data?.props?.pageProps;
  if (!pageProps) return null;

  // daodao.zone often has proposalInfo
  const title =
    asString(pageProps?.proposalInfo?.title) ||
    asString(findFirstDeep(pageProps, ["proposal", "title"])) ||
    null;

  const body =
    asString(pageProps?.proposalInfo?.description) ||
    asString(findFirstDeep(pageProps, ["proposal", "description"])) ||
    asString(findFirstDeep(pageProps, ["proposal", "body"])) ||
    null;

  // Options (best effort):
  // Try common fields that might exist in dehydrated state or page props
  const options =
    asStringArray(pageProps?.proposalInfo?.choices) ||
    asStringArray(findFirstDeep(pageProps, ["proposal", "choices"])) ||
    asStringArray(findFirstDeep(pageProps, ["proposal", "options"])) ||
    [];
// Heuristic fallback for common governance wording if options weren't found.
// Works well for daodao.zone proposals that say "Vote YES / Vote NO".
let finalOptions = options;

if ((!finalOptions || finalOptions.length === 0) && pageProps?.proposalInfo?.description) {
  const d = String(pageProps.proposalInfo.description).toUpperCase();
  const hasYes = d.includes("VOTE YES") || d.includes(" VOTE YES ");
  const hasNo = d.includes("VOTE NO") || d.includes(" VOTE NO ");
  const hasAbstain = d.includes("ABSTAIN") || d.includes("VOTE ABSTAIN");

  if (hasYes && hasNo) {
    finalOptions = hasAbstain ? ["YES", "NO", "ABSTAIN"] : ["YES", "NO"];
  }
}

  // Current results (best effort):
  // We won't assume the schema; we'll just capture something structured if present.
  const votes =
    findFirstDeep(pageProps, ["proposal", "votes"]) ||
    findFirstDeep(pageProps, ["votes"]) ||
    null;

  const status =
    asString(findFirstDeep(pageProps, ["proposal", "status"])) ||
    asString(pageProps?.proposalInfo?.status) ||
    null;

  // If we didn't get at least title/body, it's not useful.
  if (!title && !body) return null;

  return {
    title: title || "UNKNOWN",
    body: body || "",
  options: finalOptions,
    current_results: votes || status ? { votes, status } : null,
    metadata: {
      nextjs: true
    }
  };
}

function asString(v) {
  if (typeof v === "string") return v.trim();
  return null;
}

function asStringArray(v) {
  if (!Array.isArray(v)) return null;
  const arr = v
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter(Boolean);
  return arr.length ? arr : null;
}

// Best-effort deep finder for unknown nested shapes.
// Searches through objects/arrays for an object that contains path[0]...path[n].
function findFirstDeep(root, path) {
  if (!root || !path?.length) return null;

  const queue = [root];
  const seen = new Set();

  while (queue.length) {
    const cur = queue.shift();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    // Try to follow the path from this node
    let node = cur;
    let ok = true;
    for (const key of path) {
      if (node && typeof node === "object" && key in node) {
        node = node[key];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && node !== undefined) return node;

    // Continue BFS
    if (Array.isArray(cur)) {
      for (const item of cur) queue.push(item);
    } else {
      for (const k of Object.keys(cur)) queue.push(cur[k]);
    }
  }

  return null;
}
