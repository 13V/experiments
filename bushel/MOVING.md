# This directory is a staging copy

Bushel is developed as its own git repository, the way [manna](https://github.com/13V/manna) was
before it moved out of here. Its own repo — `13V/bushel`, private — does not exist yet, because the
GitHub App this session authenticates as cannot create repositories (`403 Resource not accessible
by integration` on `POST /user/repos`).

So this is a copy, kept here so an ephemeral container cannot lose it:

- **The working tree** is everything else in this directory, at Bushel's `HEAD`.
- **`bushel.bundle`** is the full repository — all six commits, with their messages, which carry the
  reasoning behind several of the corrections. Restore it with:

  ```
  git clone bushel.bundle bushel && cd bushel && git remote remove origin
  ```

To finish the move: create `13V/bushel` as a **private** repository on GitHub, then

```
git clone path/to/bushel.bundle bushel
cd bushel
git remote set-url origin https://github.com/13V/bushel
git push -u origin main
```

and delete this directory from `13V/experiments`.
