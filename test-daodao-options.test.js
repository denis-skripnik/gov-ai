import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAndExtract } from './fetcher.js';

test('fetchAndExtract infers DAO DAO standard voting options from by-voting wording', async () => {
  const originalFetch = globalThis.fetch;
  const description = `
    <strong>Actions:</strong>
    - By voting <strong>yes</strong> on this proposal, you support it.
    - By voting <strong>no</strong> on this proposal, you do not support it.
    - By voting <strong>no with veto</strong>, you find it malicious.
    - By voting <strong>abstain</strong>, you contribute to quorum.
  `;
  const nextData = {
    props: {
      pageProps: {
        proposalInfo: {
          title: 'DAO DAO options fixture',
          description,
        },
      },
    },
  };

  globalThis.fetch = async () => new Response(
    `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script></html>`,
    { status: 200, headers: { 'Content-Type': 'text/html' } },
  );

  try {
    const extracted = await fetchAndExtract('https://daodao.zone/dao/injective/proposals/659');
    assert.deepEqual(extracted.options, ['YES', 'NO', 'NO_WITH_VETO', 'ABSTAIN']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
