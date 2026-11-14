import type {
  ChannelAdapter,
  ChannelAdapterFactory,
  ChannelConfig,
  ChannelRuntimeDeps,
} from "./types";

// Registry keeps provider-specific adapter creation outside the runtime kernel.
export class ChannelAdapterRegistry {
  private readonly factories = new Map<string, ChannelAdapterFactory>();

  register(factory: ChannelAdapterFactory): void {
    if (this.factories.has(factory.type)) {
      throw new Error(`Channel adapter factory for type "${factory.type}" is already registered.`);
    }

    this.factories.set(factory.type, factory);
  }

  create(config: ChannelConfig, deps: ChannelRuntimeDeps): ChannelAdapter {
    const factory = this.factories.get(config.type);
    if (!factory) {
      const registeredTypes = [...this.factories.keys()].sort().join(", ") || "(none)";
      throw new Error(
        `Unknown channel type "${config.type}" for channel "${config.id}". Registered channel types: ${registeredTypes}. Configure a matching ChannelAdapterFactory before runtime startup.`,
      );
    }

    return factory.create(config, deps);
  }
}
