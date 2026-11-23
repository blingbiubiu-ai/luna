import type { Color, TextAlign, TextSize } from "./styles";

/**
 * Describes the Base Element contract used by Feishu interactive card rendering.
 */
export interface BaseElement<T extends string = string> {
  tag: T;
  element_id?: string;
}

/**
 * Describes the Base Container contract used by Feishu interactive card rendering.
 */
export interface BaseContainer<
  T extends string = string,
> extends BaseElement<T> {
  elements: Element[];
}

/**
 * Describes the Plain Text Element contract used by Feishu interactive card rendering.
 */
export interface PlainTextElement extends BaseElement<"plain_text"> {
  content: string;
  text_size?: TextSize;
  text_color?: Color;
  text_align?: TextAlign;
  lines?: number;
}

/**
 * Describes the Standard Icon Element contract used by Feishu interactive card rendering.
 */
export interface StandardIconElement extends BaseElement<"standard_icon"> {
  token: string;
  color?: Color;
  size?: string;
}

/**
 * Describes the Custom Icon Element contract used by Feishu interactive card rendering.
 */
export interface CustomIconElement extends BaseElement<"custom_icon"> {
  img_key: string;
  size?: string;
}

export interface ImageElement extends BaseElement<"img"> {
  img_key: string;
  alt: PlainTextElement;
  mode?: "crop_center" | "fit_horizontal";
  custom_width?: number;
}

/**
 * Represents Icon Element values used by Feishu interactive card rendering.
 */
export type IconElement = StandardIconElement | CustomIconElement;

/**
 * Describes the Div Element contract used by Feishu interactive card rendering.
 */
export interface DivElement extends BaseElement<"div"> {
  tag: "div";
  icon?: IconElement;
  text?: PlainTextElement;
  margin?: string;
  width?: string;
}

/**
 * Describes the Markdown Element contract used by Feishu interactive card rendering.
 */
export interface MarkdownElement extends BaseElement<"markdown"> {
  tag: "markdown";
  icon?: IconElement;
  margin?: string;
  text_size?: TextSize;
  text_align?: TextAlign;
  content: string;
}

/**
 * Describes the Collapsible Panel contract used by Feishu interactive card rendering.
 */
export interface CollapsiblePanel extends BaseContainer<"collapsible_panel"> {
  direction?: "vertical" | "horizontal";
  vertical_spacing?: string;
  horizontal_spacing?: string;
  vertical_align?: "top" | "center" | "bottom";
  horizontal_align?: "left" | "center" | "right";
  padding?: string;
  margin?: string;
  expanded?: boolean;
  background_color?: Color;
  border?: {
    color?: Color;
    corner_radius?: string;
  };
  header: {
    title: PlainTextElement | MarkdownElement;
    background_color?: Color;
    vertical_align?: "top" | "center" | "bottom";
    padding?: string;
    position?: "top" | "bottom";
    width?: string;
    icon?: IconElement;
    icon_position?: "left" | "right" | "follow_text";
    icon_expanded_angle?: number;
  };
}

export interface HrElement extends BaseElement<"hr"> {
  tag: "hr";
  margin?: string;
}

export interface ButtonElement extends BaseElement<"button"> {
  tag: "button";
  text: PlainTextElement;
  type?:
    | "default"
    | "primary"
    | "danger"
    | "text"
    | "primary_text"
    | "danger_text"
    | "primary_filled"
    | "danger_filled";
  size?: "tiny" | "small" | "medium" | "large";
  disabled?: boolean;
  disabled_tips?: PlainTextElement;
  behaviors?: readonly {
    readonly type: "callback";
    readonly value: Record<string, unknown>;
  }[];
}

export interface ColumnSetElement extends BaseElement<"column_set"> {
  tag: "column_set";
  flex_mode?: "none" | "stretch";
  horizontal_spacing?: string;
  margin?: string;
  columns: readonly {
    readonly tag: "column";
    readonly width: "auto" | "weighted";
    readonly elements: readonly Element[];
  }[];
}

/**
 * Represents Element values used by Feishu interactive card rendering.
 */
export type Element =
  | ButtonElement
  | CollapsiblePanel
  | ColumnSetElement
  | DivElement
  | HrElement
  | IconElement
  | ImageElement
  | MarkdownElement
  | PlainTextElement;
