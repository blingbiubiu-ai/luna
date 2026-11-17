# Runners use the Worker host UID, which has no passwd entry in the image;
# show "runner" instead of bash's "I have no name!".
if [ -n "${BASH-}" ] && [ -n "${PS1-}" ] && ! id -un >/dev/null 2>&1; then
  PS1=$(printf '%s' "$PS1" | sed 's/\\u/runner/g')
  export USER=runner
fi
