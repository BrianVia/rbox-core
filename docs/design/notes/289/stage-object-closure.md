# Complete staged-object closure

This independently testable slice of design 289 includes object roots from every
raw staged index, including ordinary captures outside conflict resolution.
Native NUL-framed stage records are validated, superproject roots are deduplicated
before existence checks, and gitlinks are excluded because their objects belong
to another repository. Missing required objects fail capture before publication.

The commit preserves the existing index-copy and identity behavior. Portable
split-index normalization follows in a separate commit.

Validation against baseline identity code under Bun 1.4.0: **27 tests passed,
229 assertions**, including independent-receiver stage-only objects,
intent-to-add, newline/tab filenames, foreign gitlinks and a missing object.
The complete design and its round-two review record accompany the subsequent
portable-index slice.
