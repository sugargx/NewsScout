import { expect } from "@playwright/test";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFString } from "pdf-lib";
import jsQR from "jsqr";
import { PNG } from "pngjs";

export async function inspectSharePdf(bytes: Uint8Array, expected: string[], portal = "") {
  const pdf = await PDFDocument.load(bytes);
  const pages = pdf.getPages(), articles: string[] = [];
  const links: { page: number; url: string; rect: number[] }[] = [];
  expect(pages.length).toBeGreaterThan(0);
  for (const [index, page] of pages.entries()) {
    const { width, height } = page.getSize();
    expect(width / height).toBeCloseTo(210 / 297, 3);
    const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    const pageArticles: { url: string; top: number; bottom: number }[] = [];
    let portals = 0;
    for (const reference of annotations?.asArray() ?? []) {
      const annotation = pdf.context.lookup(reference, PDFDict);
      expect(annotation.lookup(PDFName.of("Subtype"), PDFName).toString()).toBe("/Link");
      const action = annotation.lookup(PDFName.of("A"), PDFDict);
      expect(action.lookup(PDFName.of("S"), PDFName).toString()).toBe("/URI");
      const url = action.lookup(PDFName.of("URI"), PDFString).decodeText();
      const corners = annotation.lookup(PDFName.of("Rect"), PDFArray).asArray().map(value => pdf.context.lookup(value, PDFNumber).asNumber());
      expect(corners).toHaveLength(4);
      // A PDF rectangle is two opposite corners; jsPDF writes the top corner first.
      const rect = [Math.min(corners[0], corners[2]), Math.min(corners[1], corners[3]), Math.max(corners[0], corners[2]), Math.max(corners[1], corners[3])];
      expect(rect[0]).toBeGreaterThanOrEqual(0);
      expect(rect[1]).toBeGreaterThanOrEqual(0);
      expect(rect[2]).toBeLessThanOrEqual(width);
      expect(rect[3]).toBeLessThanOrEqual(height);
      expect(rect[2]).toBeGreaterThan(rect[0]);
      expect(rect[3]).toBeGreaterThan(rect[1]);
      const top = (height - rect[3]) / height * 1528, bottom = (height - rect[1]) / height * 1528;
      if (portal && url === portal) {
        portals++;
        expect(top).toBeCloseTo(1528 - 300 + 48, 2);
        expect(bottom).toBeLessThan(1528 - 64);
      } else {
        expect(rect[0] / width * 1080).toBeCloseTo(156, 2);
        expect(rect[2] / width * 1080).toBeCloseTo(1008, 2);
        expect(top).toBeGreaterThanOrEqual(330 - .01);
        expect(bottom).toBeLessThanOrEqual(1528 - (portal ? 300 : 150) + .01);
        pageArticles.push({ url, top, bottom });
      }
      links.push({ page: index + 1, url, rect });
    }
    expect(portals).toBe(portal ? 1 : 0);
    expect(pageArticles.length % 2).toBe(0);
    for (let index = 0; index < pageArticles.length; index += 2) {
      const title = pageArticles[index], source = pageArticles[index + 1];
      expect(source.url).toBe(title.url);
      expect(source.top).toBeGreaterThanOrEqual(title.bottom);
      if (index) expect(title.top).toBeGreaterThan(pageArticles[index - 1].bottom);
      articles.push(title.url);
    }
  }
  expect(articles).toEqual(expected);
  return { pages: pages.length, title: pdf.getTitle(), links };
}

export function inspectPortalQr(png: Buffer, expected: string) {
  const image = PNG.sync.read(png);
  const height = Math.min(Math.ceil(450 * image.width / 1080), image.height);
  const data = image.data.subarray((image.height - height) * image.width * 4);
  const qr = jsQR(new Uint8ClampedArray(data), image.width, height);
  expect(qr?.data, "Decode the actual exported PNG, not the QR generator's input").toBe(expected);
  return { width: image.width, height: image.height, portal: qr!.data, location: qr!.location };
}
