// Runs AFTER the outcomes are stored. If any email failed, raise an error so the error workflow
// notifies the administrator - the failed rows are already marked 'failed' and retry next run.
const outcomes = $('Resolve Claims').all().map((i) => i.json);
const failed = outcomes.filter((o) => o.status === 'failed');
if (failed.length > 0) {
  throw new Error(
    `${failed.length} alert email(s) failed to send (${failed.map((f) => f.dedup_key).join(', ')}); ` +
      'marked failed and will be retried next run. First error: ' + failed[0].last_error
  );
}
return [{ json: { sent: outcomes.length } }];
