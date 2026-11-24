const cors = require("cors");
const express = require("express");
const path = require("path");
const apiRoutes = require("./routes");
const errorHandler = require("./middleware/error-handler");
const notFound = require("./middleware/not-found");

const app = express();
const frontendPath = path.join(__dirname, "..", "..", "1-frontend");

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
  }),
);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.get("/styles.css", (_req, res) => {
  res.sendFile(path.join(frontendPath, "styles.css"));
});
app.get("/app.js", (_req, res) => {
  res.sendFile(path.join(frontendPath, "app.js"));
});
app.get("/marketplace-illustration.svg", (_req, res) => {
  res.sendFile(path.join(frontendPath, "marketplace-illustration.svg"));
});
app.get(["/", "/customer", "/store", "/staff"], (_req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

app.use("/api", apiRoutes);
app.use(notFound);
app.use(errorHandler);

module.exports = app;
