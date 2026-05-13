To install dependencies:
```sh
bun install
```

Database:
```sh
export DATABASE_URL="postgres://maimai:password@maimai-db-rw:5432/maimai"
```

For CloudNativePG, point `DATABASE_URL` at the cluster read-write service, usually:
```text
postgres://<user>:<password>@<cluster-name>-rw:5432/<database>
```

To run:
```sh
bun run dev
```

open http://localhost:3000
