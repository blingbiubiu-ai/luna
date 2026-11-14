#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

VARIANT="${LUNA_RUNNER_VARIANT:-general}"
TAG="latest"
TAG_SET=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --variant) [ "$#" -ge 2 ] || { echo "--variant requires general or android" >&2; exit 1; }; VARIANT="$2"; shift 2 ;;
    --help|-h) echo "Usage: build.sh [TAG] [--variant general|android]"; exit 0 ;;
    --*) echo "Unknown option: $1" >&2; exit 1 ;;
    *) [ "$TAG_SET" = 0 ] || { echo "Only one tag is allowed" >&2; exit 1; }; TAG="$1"; TAG_SET=1; shift ;;
  esac
done
case "$VARIANT" in
  general) IMAGE_NAME="${LUNA_RUNNER_IMAGE_NAME:-luna-runner}"; DOCKERFILE="Dockerfile" ;;
  android) IMAGE_NAME="${LUNA_RUNNER_IMAGE_NAME:-luna-runner-android}"; DOCKERFILE="local/android/Dockerfile.android" ;;
  *) echo "Unknown variant: $VARIANT (expected general or android)" >&2; exit 1 ;;
esac
PLATFORM="${LUNA_RUNNER_PLATFORM:-linux/amd64}"
RUNNER_BASE_IMAGE="${LUNA_RUNNER_BASE_IMAGE:-luna-runner-base:$TAG}"
ANDROID_BASE_IMAGE="${LUNA_ANDROID_BASE_IMAGE:-luna-android-base:jdk17-ndk25}"
BUILD_ARGS=(--build-arg "NODE_IMAGE=${LUNA_NODE_IMAGE:-node:22-slim}")
if [ "${LUNA_DOCKER_NO_CACHE:-0}" = 1 ]; then BUILD_ARGS+=(--no-cache); fi
if [ "$VARIANT" = android ]; then
  for private_file in "$DOCKERFILE" local/android/Dockerfile.android-base; do
    [ -f "$SCRIPT_DIR/$private_file" ] || { echo "Android variant requires local configuration: container/$private_file (see container/README.md)" >&2; exit 1; }
  done
  [ "$PLATFORM" = linux/amd64 ] || { echo "Android requires linux/amd64" >&2; exit 1; }
  if [ "${LUNA_REBUILD_ANDROID_BASE:-0}" = "1" ] || \
     ! docker image inspect "$ANDROID_BASE_IMAGE" >/dev/null 2>&1; then
    echo "Building stable Android base image: $ANDROID_BASE_IMAGE"
    docker build \
      --platform "$PLATFORM" \
      -f "$SCRIPT_DIR/local/android/Dockerfile.android-base" \
      -t "$ANDROID_BASE_IMAGE" \
      .
  else
    echo "Reusing stable Android base image: $ANDROID_BASE_IMAGE"
  fi

fi

# Bundle the exact checkout's client; remote Workers cannot mount Service host files.
bun build "$SCRIPT_DIR/../apps/cli/src/main.ts" --target=bun --outfile="$SCRIPT_DIR/../dist/luna-client.js"

echo "Building shared runner base: $RUNNER_BASE_IMAGE"
docker build \
  --platform "$PLATFORM" \
  "${BUILD_ARGS[@]}" \
  -f "$SCRIPT_DIR/Dockerfile.base" \
  -t "$RUNNER_BASE_IMAGE" \
  "$SCRIPT_DIR/.."

VARIANT_ARGS=(--build-arg "RUNNER_BASE_IMAGE=$RUNNER_BASE_IMAGE")
if [ "$VARIANT" = android ]; then VARIANT_ARGS+=(--build-arg "ANDROID_BASE_IMAGE=$ANDROID_BASE_IMAGE"); fi
if [ "${LUNA_DOCKER_NO_CACHE:-0}" = 1 ]; then VARIANT_ARGS+=(--no-cache); fi
echo "Building Luna runner image: ${IMAGE_NAME}:${TAG}"
docker build \
  --platform "$PLATFORM" \
  "${VARIANT_ARGS[@]}" \
  -f "$SCRIPT_DIR/$DOCKERFILE" \
  -t "${IMAGE_NAME}:${TAG}" \
  "$SCRIPT_DIR/.."
echo "Build complete: ${IMAGE_NAME}:${TAG}"
