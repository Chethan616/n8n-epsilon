// One-time setup: emit the run-lock row only if it does not exist yet, so re-running Setup is safe.
const existing = $input.all().some((i) => i.json && i.json.dedup_key === '__run_lock__');
if (existing) return [];
return [
  {
    json: {
      dedup_key: '__run_lock__',
      status: 'lock',
      claim_id: null,
      claimed_at: '1970-01-01T00:00:00.000Z',
      version: 1,
    },
  },
];
