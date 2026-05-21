export type ImageInput = {
  data?: string;
  data_base64?: string;
  mime_type?: string;
  mimeType?: string;
};

export class Image {
  readonly data_base64!: string;
  readonly mime_type!: string;
  readonly __obuImage!: true;
  readonly data!: string;

  constructor(dataBase64: string, mimeType = "image/png") {
    Object.defineProperties(this, {
      data_base64: { value: dataBase64, enumerable: true },
      mime_type: { value: mimeType, enumerable: true },
      __obuImage: { value: true, enumerable: false },
      data: { get: () => dataBase64, enumerable: false },
    });
  }

  static from(value: Image | ImageInput): Image {
    if (value instanceof Image) return value;
    return new Image(value.data_base64 ?? value.data ?? "", value.mime_type ?? value.mimeType ?? "image/png");
  }

  toBase64(): string {
    return this.data_base64;
  }

  toDisplayValue(): { __obuImage: true; mime_type: string; data: string } {
    return {
      __obuImage: true,
      mime_type: this.mime_type,
      data: this.data_base64,
    };
  }

  toJSON(): { data_base64: string; mime_type: string } {
    return {
      data_base64: this.data_base64,
      mime_type: this.mime_type,
    };
  }
}

export function isImage(value: unknown): value is Image {
  return value instanceof Image;
}
