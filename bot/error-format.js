function normalizeErrorMessage(error) {
  return String(error?.message || error || "").trim();
}

function includesAny(text, parts) {
  const lower = text.toLowerCase();
  return parts.some((part) => lower.includes(part));
}

export function formatUserFacingAnalysisError(error) {
  const rawMessage = normalizeErrorMessage(error);

  if (!rawMessage) {
    return {
      summary: "Analysis could not be completed.",
      detail: "Please try again in a few minutes.",
    };
  }

  if (includesAny(rawMessage, ["no matching report file was found", "report file was found"])) {
    return {
      summary: "Analysis finished, but the report could not be loaded.",
      detail: "Please retry this proposal. If it happens again, the report generation flow likely needs attention.",
    };
  }

  if (includesAny(rawMessage, ["exit code", "gov-ai exited", "spawn", "eacces", "enoent"])) {
    return {
      summary: "Analysis stopped before a result was produced.",
      detail: "Retrying may help. If the same proposal fails again, the analysis service likely needs attention.",
    };
  }

  if (includesAny(rawMessage, ["invalid url", "unsupported url", "validation"])) {
    return {
      summary: "This proposal link could not be analyzed.",
      detail: "Please check the URL and try again with a supported governance proposal link.",
    };
  }

  return {
    summary: "Analysis could not be completed.",
    detail: "Please try again in a few minutes. If the problem repeats, the analysis service likely needs attention.",
  };
}
