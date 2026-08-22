import cartridgeDocument from "../content/incidents/phase-1-demo.json";
import { mountApp } from "./app.js";
import "./styles.css";

const mount = document.querySelector<HTMLElement>("#app");
if (mount === null) throw new Error("The runtime mount point is missing.");

mountApp(document, mount, cartridgeDocument);
