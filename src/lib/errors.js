/** Kesalahan dengan status HTTP dan pesan yang aman ditampilkan ke pengguna. */
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}
