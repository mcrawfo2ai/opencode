export S=${S:?set S to a scratch directory}
export PATH=$S/bin:$PATH
export OCBIN=${OCBIN:-$S/oc/packages/opencode/dist/opencode-linux-x64/bin/opencode}
export RUN=${RUN:-$S/run1}
export HOME=$RUN/home
export XDG_CONFIG_HOME=$RUN/home/.config XDG_DATA_HOME=$RUN/home/.local/share XDG_STATE_HOME=$RUN/home/.local/state XDG_CACHE_HOME=$RUN/home/.cache
export OPENCODE_DISABLE_MODELS_FETCH=1 OPENCODE_DISABLE_AUTOUPDATE=1
export GIT_CONFIG_GLOBAL=$RUN/home/.gitconfig
unset BUN_OPTIONS
