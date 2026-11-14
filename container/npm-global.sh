# The service supplies the persistent home for this runner at launch.
if [ -n "${HOME:-}" ]; then
  export npm_config_prefix="${npm_config_prefix:-${NPM_CONFIG_PREFIX:-$HOME/.npm-global}}"
  case ":$PATH:" in
    *":$npm_config_prefix/bin:"*) ;;
    *) export PATH="$PATH:$npm_config_prefix/bin" ;;
  esac
fi
