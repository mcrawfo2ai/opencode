export S=${S:?set S}
export RUN=${RUN:?set RUN}
export HOME=$RUN/home XDG_CONFIG_HOME=$RUN/home/.config XDG_DATA_HOME=$RUN/home/.local/share XDG_STATE_HOME=$RUN/home/.local/state XDG_CACHE_HOME=$RUN/home/.cache
export GIT_CONFIG_GLOBAL=$RUN/home/.gitconfig
# Explicit PATH: no /opt/node22/bin (a logged-in `claude` CLI lives there).
export PATH=$S/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1
# Sandbox: no Go module proxy; projects resolve deps through local replace directives.
export GOPROXY=off GOSUMDB=off GOFLAGS=-mod=mod GOTOOLCHAIN=local GOPATH=$RUN/home/go GOCACHE=$RUN/home/.cache/go-build
unset BUN_OPTIONS BUN_FEATURE_FLAG_DISABLE_STANDALONE_MADVISE
