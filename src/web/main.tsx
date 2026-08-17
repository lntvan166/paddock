import { createRoot } from "react-dom/client";
import { App } from "@web/components/App";
import "@web/styles.css";

const el = document.getElementById("root");
if (!el) throw new Error("#root missing from index.html");
createRoot(el).render(<App />);
