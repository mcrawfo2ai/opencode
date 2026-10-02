#!/bin/sh
# Private-/tmp wrapper: new mount namespace, workspace scratch bound over /tmp, common temp/cache vars redirected.
S=/home/user/opencode/.spike-scratch
exec unshare -m --propagation private sh -c '
  mount --bind '"$S"'/tmp /tmp || exit 97
  export TMPDIR=/tmp TMP=/tmp TEMP=/tmp
  export XDG_CACHE_HOME=/tmp/xdg-cache npm_config_cache=/tmp/npm-cache BUN_INSTALL_CACHE_DIR=/tmp/bun-cache
  mkdir -p /tmp/xdg-cache /tmp/npm-cache /tmp/bun-cache
  exec "$@"
' sh "$@"
