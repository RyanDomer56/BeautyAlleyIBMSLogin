import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./App";
import { consoleRedirectTarget } from "./lib/console";
import "./index.css";

/**
 * Console routes on the public origin are handed to the console's own origin
 * before React mounts, so the booking site never renders a staff screen — not
 * even for a frame.
 */
const consoleTarget = consoleRedirectTarget();

if (consoleTarget) {
  window.location.replace(consoleTarget);
} else {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </React.StrictMode>,
  );
}
