import { createApp } from "../server.js";

let app: any = null;

export default (req: any, res: any) => {
  if (!app) {
    createApp().then((newApp) => {
      app = newApp;
      app(req, res);
    }).catch((err: any) => {
      console.error("App creation error:", err);
      res.status(500).json({ error: err?.message || "Failed to initialize server" });
    });
  } else {
    app(req, res);
  }
};
