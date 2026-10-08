// A get_template_layers response shaped like the API's: every Layer DTO field is
// serialized (Jackson keeps nulls), in declaration order, with the values
// TemplateService.getLayers extracts from a real template. 47 layers across
// 5 pages, the size of the template measured in the Verified audit.

const LAYER_FIELDS = [
  "layer", "type", "description", "text", "color", "color_2", "font_family", "font_family_2",
  "font_size", "font_weight", "letter_spacing", "text_transform", "line_height",
  "horizontal_align", "vertical_align", "autofit", "min_font_size", "max_font_size",
  "image_url", "image_base64", "object_fit", "object_position", "crop_x", "crop_y",
  "crop_width", "crop_height", "filter", "blend_mode", "video_url", "x", "y", "width",
  "height", "rotation", "background", "border_width", "border_color", "border_radius",
  "border_style", "dash_length", "dash_gap", "fill", "stroke", "hide", "link", "html",
  "barcode_format", "order", "rating", "rating_shape", "rating_fill_color",
  "rating_shade_color", "rating_border_color", "rating_max", "rating_spacing",
  "rating_star_size", "locked", "opacity", "text_stroke_width", "text_stroke_color",
  "text_highlight_color", "padding_x", "padding_y", "flip_x", "flip_y", "preserve_ratio",
  "animation", "group",
];

type Layer = Record<string, unknown>;

function blank(name: string, type: string): Layer {
  const layer: Layer = {};
  for (const field of LAYER_FIELDS) layer[field] = null;
  // getLayers always fills these, even when the template has no value for them.
  Object.assign(layer, {
    layer: name, type, description: "", color: "rgba(0, 0, 0, 1)", autofit: "",
    hide: false, locked: false, rotation: 0,
  });
  return layer;
}

function text(name: string, value: string, x: number, y: number, size: number): Layer {
  return Object.assign(blank(name, "text"), {
    text: value, color: "rgba(27, 33, 35, 1)", font_family: "Montserrat", font_size: `${size}px`,
    font_weight: "700", letter_spacing: "0px", line_height: "1.2", horizontal_align: "center",
    vertical_align: "center", autofit: "width", x, y, width: 920, height: Math.round(size * 1.6),
    padding_x: 0, padding_y: 0,
  });
}

function image(name: string, url: string, x: number, y: number, w: number, h: number): Layer {
  return Object.assign(blank(name, "image"), {
    image_url: url, object_fit: "cover", object_position: "50% 50%", border_radius: "0px",
    x, y, width: w, height: h,
  });
}

function shape(name: string, fill: string, x: number, y: number, w: number, h: number): Layer {
  return Object.assign(blank(name, "shape"), {
    fill, background: null, border_radius: "24px", x, y, width: w, height: h,
    html: `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><rect width="${w}" height="${h}" rx="24" fill="${fill}"/></svg>`,
    preserve_ratio: false,
  });
}

export function templateLayersFixture(): Layer[] {
  const layers: Layer[] = [];
  for (let page = 1; page <= 5; page++) {
    const p = `p${page}`;
    layers.push(
      shape(`${p}-background`, "#F4EFE6", 0, 0, 1080, 1350),
      text(`${p}-title`, `Five ways to cut render costs, part ${page}`, 80, 140, 72),
      text(`${p}-subtitle`, "What we learned shipping 2M renders a month", 80, 320, 36),
      text(`${p}-body`, "Batch similar renders, reuse templates across sizes and keep images under 3 MP so the light renderer handles them.", 80, 420, 28),
      image(`${p}-photo`, `https://templated-assets.s3.amazonaws.com/public/uploads/team-7f3a/${p}-photo-6c1e2b.jpg`, 80, 620, 920, 520),
      image(`${p}-logo`, "https://templated-assets.s3.amazonaws.com/public/uploads/team-7f3a/logo-dark.png", 80, 1200, 180, 60),
      shape(`${p}-cta-bg`, "#1B2123", 640, 1190, 360, 80),
      text(`${p}-cta`, "Read the guide", 640, 1205, 30),
      text(`${p}-page-number`, `${page}/5`, 940, 60, 24),
    );
  }
  layers.push(
    text("handle", "@templated", 80, 60, 24),
    image("qr", "https://templated-assets.s3.amazonaws.com/public/uploads/team-7f3a/qr.png", 900, 1180, 100, 100),
  );
  return layers;
}
