# Google Photos Swipe

A vocabulary for reviewing a Google Photos library one photo at a time.

## Language

**Review**:
A decision to keep or successfully remove a distinct photo presented by the extension. Viewing a photo alone is not a review.

**Keep**:
A decision to retain a photo, recorded locally without changing it in Google Photos.
_Avoid_: Accept, favorite, archive

**Trash**:
The recoverable Google Photos destination for photos removed through the extension. Moving a photo to trash is distinct from permanently deleting it.
_Avoid_: Permanent deletion

**Photo**:
A still image in the user's Google Photos library.

**File size**:
The size in bytes of a photo's stored file.
_Avoid_: Storage freed, quota reclaimed

**Quota contribution**:
The amount of Google account storage attributed to a photo, when known. A photo can have a nonzero file size while contributing nothing to account storage.

**Quota status**:
Whether a photo counts toward Google account storage: consuming, non-consuming, or unknown.

**Estimated storage removed**:
The sum of known quota contributions of photos successfully moved to trash through the extension. It is an estimate rather than a measurement of available account storage.

**Capture date**:
The date a photo was taken, when known.
_Avoid_: Upload date
