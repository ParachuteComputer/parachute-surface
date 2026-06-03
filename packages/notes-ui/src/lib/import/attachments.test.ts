import { describe, expect, it } from "vitest";
import { assertUploadable, classifyExt, classifyFilename, isUploadableKind } from "./attachments";

describe("non-md attachment classification", () => {
  it("classifies images (png/jpg/jpeg/gif/webp) as image", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp"]) {
      expect(classifyExt(ext)).toBe("image");
    }
  });

  it("classifies pdf as pdf, mp4 as video, audio extensions as audio", () => {
    expect(classifyExt("pdf")).toBe("pdf");
    expect(classifyExt("mp4")).toBe("video");
    for (const ext of ["wav", "mp3", "m4a", "ogg", "webm"]) {
      expect(classifyExt(ext)).toBe("audio");
    }
  });

  it("classifies text-shaped data (txt/json/csv/yaml/yml/svg) as text", () => {
    for (const ext of ["txt", "json", "csv", "yaml", "yml", "svg"]) {
      expect(classifyExt(ext)).toBe("text");
    }
  });

  it("classifies unknown binary as unsupported", () => {
    expect(classifyExt("docx")).toBe("unsupported");
    expect(classifyExt("zip")).toBe("unsupported");
    expect(classifyExt("")).toBe("unsupported");
  });

  it("is case-insensitive", () => {
    expect(classifyExt("PNG")).toBe("image");
    expect(classifyFilename("PHOTO.JPG")).toBe("image");
  });

  it("isUploadableKind is true only for image/pdf/audio/video", () => {
    expect(isUploadableKind("image")).toBe(true);
    expect(isUploadableKind("pdf")).toBe(true);
    expect(isUploadableKind("audio")).toBe(true);
    expect(isUploadableKind("video")).toBe(true);
    expect(isUploadableKind("text")).toBe(false);
    expect(isUploadableKind("unsupported")).toBe(false);
  });

  it("assertUploadable cross-checks the server storage allowlist", () => {
    // Storage-allowlisted + uploadable.
    expect(assertUploadable("png")).toBe(true);
    expect(assertUploadable("pdf")).toBe(true);
    expect(assertUploadable("mp4")).toBe(true);
    // Text-shaped: classified text, NOT on the storage allowlist.
    expect(assertUploadable("json")).toBe(false);
    expect(assertUploadable("svg")).toBe(false);
    expect(assertUploadable("docx")).toBe(false);
  });
});
