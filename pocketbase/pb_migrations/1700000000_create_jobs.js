migrate((app) => {
  const collection = new Collection({
    type: "base",
    name: "jobs",
    listRule: "owner = @request.auth.id",
    viewRule: "owner = @request.auth.id",
    createRule: "@request.auth.id != '' && owner = @request.auth.id",
    updateRule: "owner = @request.auth.id",
    deleteRule: "owner = @request.auth.id",
    fields: [
      {
        name: "jobKey",
        type: "text",
        required: true,
        min: 36,
        max: 36,
        pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
      },
      {
        name: "owner",
        type: "relation",
        required: true,
        minSelect: 1,
        maxSelect: 1,
        collectionId: "_pb_users_auth_",
        cascadeDelete: true,
      },
      {
        name: "operation",
        type: "select",
        required: true,
        maxSelect: 1,
        values: [
          "image_to_pdf",
          "pdf_to_image",
          "merge_pdf",
          "split_pdf",
          "compress_pdf",
        ],
      },
      {
        name: "status",
        type: "select",
        required: true,
        maxSelect: 1,
        values: ["queued", "processing", "ready", "failed", "downloaded", "expired"],
      },
      { name: "inputNames", type: "json", required: true },
      { name: "outputName", type: "text" },
      { name: "errorCode", type: "text" },
      { name: "createdAt", type: "date", required: true },
      { name: "expiresAt", type: "date", required: true },
      { name: "downloadedAt", type: "date" },
    ],
    indexes: ["CREATE UNIQUE INDEX idx_jobs_job_key ON jobs (jobKey)"],
  });

  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("jobs");
  app.delete(collection);
});
