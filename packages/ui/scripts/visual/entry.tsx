/* The port as the design system's previews expect it: window.React, window.ReactDOM and window.WalkieTalkey. */
import * as React from "react";
import * as ReactDOM from "react-dom/client";
import * as UI from "../../src";

Object.assign(window, { React, ReactDOM, WalkieTalkey: UI });
