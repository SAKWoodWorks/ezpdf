migrate((app) => {
  const collection = app.findCollectionByNameOrId("jobs");
  // Only the server and worker may set owner, paths, status, or expiry. Owners
  // retain read access; their user token must never authorize metadata writes.
  collection.listRule = "@request.auth.id != '' && owner = @request.auth.id";
  collection.viewRule = "@request.auth.id != '' && owner = @request.auth.id";
  collection.createRule = null;
  collection.updateRule = null;
  collection.deleteRule = null;
  const status = collection.fields.getByName("status");
  status.values = ["uploading", "queued", "processing", "ready", "failed", "downloaded", "expired"];
  collection.fields.add(new JSONField({ name: "options" }));
  app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("jobs");
  collection.fields.removeByName("options");
  // Keep trusted writes locked during rollback as well.
  app.save(collection);
});
