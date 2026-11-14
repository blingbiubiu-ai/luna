VARIANT ?= general
IMAGE_NAME ?= $(if $(filter android,$(VARIANT)),luna-runner-android,luna-runner)
TAG ?= latest
PLATFORM ?= linux/amd64
RUNNER_BASE_IMAGE ?= luna-runner-base:$(TAG)
ANDROID_BASE_IMAGE ?= luna-android-base
ANDROID_BASE_TAG ?= jdk17-ndk25
FULL_IMAGE = $(IMAGE_NAME):$(TAG)
FULL_ANDROID_BASE_IMAGE = $(ANDROID_BASE_IMAGE):$(ANDROID_BASE_TAG)

.PHONY: android-base android-base-refresh build build-no-cache push test smoke shell clean help

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

android-base: check-android-local ## Build the stable Android base only when it is missing
	@if docker image inspect $(FULL_ANDROID_BASE_IMAGE) >/dev/null 2>&1; then \
		echo "Reusing $(FULL_ANDROID_BASE_IMAGE)"; \
	else \
		docker build --platform $(PLATFORM) -f local/android/Dockerfile.android-base -t $(FULL_ANDROID_BASE_IMAGE) .; \
	fi

android-base-refresh: check-android-local ## Explicitly rebuild the stable Android base
	docker build --platform $(PLATFORM) -f local/android/Dockerfile.android-base -t $(FULL_ANDROID_BASE_IMAGE) .

build: ## Build selected variant (VARIANT=general|android)
	LUNA_RUNNER_BASE_IMAGE=$(RUNNER_BASE_IMAGE) LUNA_RUNNER_IMAGE_NAME=$(IMAGE_NAME) LUNA_RUNNER_PLATFORM=$(PLATFORM) LUNA_ANDROID_BASE_IMAGE=$(FULL_ANDROID_BASE_IMAGE) bash build.sh $(TAG) --variant $(VARIANT)

build-no-cache: ## Rebuild selected runtime without cache
	LUNA_DOCKER_NO_CACHE=1 $(MAKE) build

push: ## Push image to registry (set IMAGE_NAME/TAG)
	docker push $(FULL_IMAGE)

smoke: build ## Quick smoke test: send a prompt through the container
	@echo "--- Smoke test: entrypoint → agent-runner → marker output ---"
	@echo '{"prompt":"hello smoke test","runnerType":"claude"}' | \
		docker run --rm -i $(FULL_IMAGE) 2>&1 | head -30
	@echo "--- Smoke test complete ---"

test: build ## Full test: launch container, verify marker protocol, inject IPC
	@echo "--- Full container test ---"
	@bash test-container.sh $(FULL_IMAGE) $(VARIANT)
	@echo "--- Full container test complete ---"

shell: build ## Drop into an interactive shell inside the container
	docker run --rm -it --entrypoint /bin/bash $(FULL_IMAGE)

clean: ## Remove the built image
	docker rmi $(FULL_IMAGE) 2>/dev/null || true

.PHONY: check-android-local
check-android-local:
	@test -f local/android/Dockerfile.android-base || { echo "Android variant requires local configuration (see container/README.md)" >&2; exit 1; }
