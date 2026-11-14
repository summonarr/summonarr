// The settings library pickers' list (src/lib/client/library-items.ts): one
// checked shape for the Plex sections and Jellyfin folders the libraries route
// answers. A non-list answer is a load error, not a render crash, and a named
// Jellyfin server's folders (lowercase `id`/`name`) are read as such.
import { test } from "node:test";
import assert from "node:assert/strict";
import { librariesPath, parseLibraryItems } from "../src/lib/client/library-items.ts";

test("Plex sections become items, the kind from the section type", () => {
  assert.deepEqual(
    parseLibraryItems("plex", [{ key: "1", title: "Movies", type: "movie" }, { key: "2", title: "TV", type: "show" }]),
    [{ id: "1", title: "Movies", kind: "movie" }, { id: "2", title: "TV", kind: "tv" }],
  );
});

test("Jellyfin folders become items, the kind from the collection type", () => {
  assert.deepEqual(
    parseLibraryItems("jellyfin", [{ id: "a1", name: "Films", collectionType: "movies" }, { id: "b2", name: "Shows", collectionType: "tvshows" }]),
    [{ id: "a1", title: "Films", kind: "movie" }, { id: "b2", title: "Shows", kind: "tv" }],
  );
});

test("a mixed Jellyfin library is its own kind, never labelled TV", () => {
  assert.deepEqual(
    parseLibraryItems("jellyfin", [{ id: "c3", name: "Anime", collectionType: "mixed" }]),
    [{ id: "c3", title: "Anime", kind: "mixed" }],
  );
});

test("an answer that isn't the list is null, never thrown or kept", () => {
  for (const data of [null, {}, { error: "Bad gateway" }, "x", [{ key: 1, title: "x", type: "movie" }]]) {
    assert.equal(parseLibraryItems("plex", data), null, JSON.stringify(data));
  }
  // The other service's field names are not this service's list.
  assert.equal(parseLibraryItems("jellyfin", [{ Id: "a1", Name: "Films", CollectionType: "movies" }]), null);
  assert.equal(parseLibraryItems("jellyfin", [{ key: "1", title: "Movies", type: "movie" }]), null);
});

test("an empty key has no checkbox", () => {
  assert.deepEqual(parseLibraryItems("plex", [{ key: "", title: "x", type: "movie" }]), []);
  assert.deepEqual(parseLibraryItems("jellyfin", []), []);
});

test("the route names a named server by its slug, and the default by none", () => {
  assert.equal(librariesPath("plex"), "/api/settings/plex/libraries");
  assert.equal(librariesPath("jellyfin", "4k remote"), "/api/settings/jellyfin/libraries?instance=4k%20remote");
});
