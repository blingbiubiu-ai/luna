import type { Element, IconElement, PlainTextElement } from "./elements";

/**
 * Describes the Card Config contract used by Feishu interactive card rendering.
 */
export interface CardConfig {
  streaming_mode: boolean;
  width_mode?: "fill" | "compact";
  use_custom_translation?: boolean;
  enable_forward?: boolean;
  enable_forward_interaction?: boolean;
  update_multi?: boolean;
  summary: {
    content: string;
  };
}

/**
 * Describes the Card Head contract used by Feishu interactive card rendering.
 */
export interface CardHead {
  icon?: IconElement;
  title: PlainTextElement;
  subtitle?: PlainTextElement;
  template?:
    | "default"
    | "blue"
    | "wathet"
    | "turquoise"
    | "green"
    | "yellow"
    | "orange"
    | "red"
    | "carmine"
    | "violet"
    | "purple"
    | "indigo"
    | "grey";
  padding?: string;
}

/**
 * Describes the Card Body contract used by Feishu interactive card rendering.
 */
export interface CardBody {
  direction?: "vertical" | "horizontal";
  padding?: string;
  horizontal_spacing?: string;
  horizontal_align?: "left" | "center" | "right";
  vertical_spacing?: string;
  elements: Element[];
}

/**
 * Describes the Card contract used by Feishu interactive card rendering.
 */
export interface Card {
  schema: "2.0";
  config?: CardConfig;
  header?: CardHead;
  body: CardBody;
}
