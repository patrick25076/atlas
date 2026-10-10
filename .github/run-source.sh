# Sourced by the refresh workflow: run one ingest with a second try, never stop the job.
# A source that fails twice is written to $RUNNER_TEMP/failed-sources.txt; its previous data
# file stays in the repository (the ingests write their file only at the end), and the
# workflow's last step fails the run with the names once the other sources are committed.
run_source() {
  local name="$1"
  for attempt in 1 2; do
    if pnpm "$name"; then
      return 0
    fi
    echo "::warning::$name failed (attempt $attempt)"
    [ "$attempt" = 1 ] && sleep 30
  done
  echo "$name" >> "$RUNNER_TEMP/failed-sources.txt"
  return 0
}
