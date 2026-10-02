# Run A (first official pass; kept for repeatability only)

Same probe scripts as run B except the cleanup stage. Run A's cleanup closed owned sockets (including the daemon
owner connections) BEFORE removing owned PTYs / requesting daemon shutdown, so the daemons self-exited on owner close
and the explicit PTY-removal/shutdown steps were moot; its leftover scan also matched the cloud tool shell's own
command text (a false positive). Its `cleanup.json` was therefore omitted here. Case/controls/matrix evidence is unchanged.
Run B (`../evidence/`) is the primary evidence set.

Post-hoc edit (before commit): `run.json` originally listed the host process's environment variable names
(`isolation.process_env_keys_present`, names only, no values). That field was removed and replaced by a count
(`harness_process_env_var_count`) because env-var name dumps are not to be committed; the final scripts record only the
count. The manifest hash for this file is for the edited version. No other evidence file was edited.
