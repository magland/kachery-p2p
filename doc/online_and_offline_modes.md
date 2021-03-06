## kachery-p2p online and offline modes

Kachery-p2p comprises a Python client, a command-line interface, and a daemon server.

## Kachery-p2p daemon

Although some kachery-p2p client operations can run in offline mode (see below), it is recommended that you maintain a running kachery-p2p daemon when using kachery-p2p. Instructions for starting the daemon can be found [here](./setup_and_installation.md).

## Online vs offline mode

The kachery-p2p client can either operate in online mode (by connecting to a running daemon) or in a limited offline mode by interacting directly with the locally-mounted file system.

If the `KACHERY_OFFLINE_STORAGE_DIR` environment variable is set, the client will operate in the limited offline mode where it can only load and store static files in the `$KACHERY_OFFLINE_STORAGE_DIR` directory. It cannot read or write feeds and cannot interact with other nodes in the kachery-p2p network.

By default (if the offline environment variable is not set), kachery-p2p will attempt to connect to a running daemon on the default port 20421, and will raise an exception if this connection fails. This port can be configured using the `KACHERY_P2P_API_PORT` environment variable.

When a daemon is running and the client is connected to the daemon (i.e., in online mode), it is not necessary for the `KACHERY_STORAGE_DIR` environment variable to be set because the location of this directory is communicated from the daemon to the client. If this variable *is* set, but is inconsistent with the storage directory of the daemon, then the kachery client will raise a Python exception.

Note that if `KACHERY_OFFLINE_STORAGE_DIR` is set, then the client will be in offline mode even if a daemon is running (i.e., the variable takes precedence).

## Loading files

The following Python client operations can be used to load files and data:

```
kp.load_file(uri: str) -> file path on local system OR None
kp.load_text(uri: str) -> str OR None
kp.load_object(uri: str) -> dict OR None
kp.load_npy(uri: str) -> np.ndarray OR None
kp.load_pkl(uri: str) -> Any OR None
kp.load_bytes(uri: str, start: int, end: int)-> bytearray OR None
```

Whether in offline or online mode, kachery will first directly check the storage directory ($KACHERY_OFFLINE_STORAGE_DIR in offline mode, or the one specified by the daemon in online mode) for the file with the given kachery URI. If it is not found, and we are in online mode, then the client will make the load request to the daemon. The daemon will then attempt to load the file from the kachery-p2p network. If the load is successful, then the file content may then be loaded by the Python client from the kachery storage directory.

## Storing files

The following Python client operations can be used to store files and data in the kachery storage for the local node:

```
kp.store_file(path: str) -> uri
kp.store_text(txt: str) -> uri
kp.store_json(x: dict) -> uri
kp.store_npy(x: np.ndarray) -> uri
kp.store_pkl(x: Any) -> uri
```

Kachery will first compute the URI of the data to be stored and check whether it already exists in the kachery storage for the local node. If it already exists, these functions simply return the URI string.

When in offline mode, kachery will store the data directly to the `$KACHERY_OFFLINE_STORAGE_DIR` directory. Otherwise, it will send data to the daemon, and the daemon will store the file in the storage location for the local node.

## Recommendation for multiple users sharing the same computer

If multiple users are sharing the same machine, then it is recommended that one of the users (or perhaps a service user) maintains the running daemon, and that the `KACHERY_STORAGE_DIR` environment variable is set to a directory that is readable (but not writeable) by all users. The `KACHERY_STORAGE_DIR` environment variable should be set for the running daemon, but no environment variables need to be set for the users because the location of the kachery storage directory is obtained from the running daemon.
