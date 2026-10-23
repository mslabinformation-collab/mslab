"use client";

import { useState, type ComponentProps } from "react";
import { FoldRow } from "./FoldRow";

/**
 * The fold „Tehtud ({n})“ of Päringud: a FoldRow that opens by itself when it is all there is (`defaultOpen`: nothing is open in the tab, or a search's hits are all
 * done), and is never closed by the page afterwards. A plain FoldRow follows its `defaultOpen` both ways, so marking a done request „Märgi tegemata“ — the page then
 * has an open one, the default turns false — would shut the fold under the visitor, with the rest of the done requests in it. Here a default that has been true
 * stays true until the component goes: the page gives it a `key` for the view (the tab and the search), so another list starts from its own default. What the
 * visitor does with the row (opening or shutting it) is the browser's, as in FoldRow.
 */
export function RequestFold(props: ComponentProps<typeof FoldRow>) {
  const [latched, setLatched] = useState(Boolean(props.defaultOpen));
  // (state adjusted while rendering, as react.dev advises, not in an effect: the first render with the default true is already open)
  if (props.defaultOpen && !latched) setLatched(true);
  return <FoldRow {...props} defaultOpen={latched} />;
}
