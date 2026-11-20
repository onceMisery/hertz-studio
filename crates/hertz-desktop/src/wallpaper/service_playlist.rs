// SPDX-License-Identifier: MIT
use super::*;

pub(super) async fn validate_properties(
    jobs: &Arc<ImportJobs>,
    items: &[crate::wallpaper::playlist::FixedVersion],
    properties: &[serde_json::Map<String, Value>],
) -> Result<(), JobError> {
    if properties.is_empty() {
        return Ok(());
    }
    let source = Arc::clone(jobs);
    let references = items.to_vec();
    let overrides = properties.to_vec();
    let runtime = tokio::runtime::Handle::current();
    tokio::task::spawn_blocking(move || {
        runtime.block_on(async {
            let cancel = AtomicBool::new(false);
            for properties in &overrides {
                crate::wallpaper::public_properties::validate_references(
                    &source,
                    &references,
                    properties,
                    &cancel,
                )
                .await?;
            }
            Ok(())
        })
    })
    .await
    .map_err(|_| JobError::new("worker_unavailable", "轮播公开属性核验线程已退出"))?
}

impl State {
    pub(super) async fn update_playlist(
        self: &Arc<Self>,
        update: crate::wallpaper::playlist::edit::Update,
        owner: u64,
        properties: &[serde_json::Map<String, Value>],
    ) -> Result<Value, JobError> {
        self.check_owner(owner)?;
        let jobs = self.jobs().await?;
        let _writer = jobs.assets().content_writer()?;
        let repository = crate::wallpaper::playlist::Repository::new(jobs.library());
        let candidate = repository.candidate(update).await?;
        validate_properties(jobs, &candidate.items, properties).await?;
        Ok(repository.commit_candidate(candidate).await?.receipt())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wallpaper::{
        library::tempfileish,
        work_drafts::{Document, WorkDrafts},
    };

    fn request(id: &str, command: &str, payload: Value) -> Request {
        Request::parse(json!({"protocol":2,"requestId":id,"command":command,"payload":payload}))
            .unwrap()
    }
    fn call(
        service: &LibraryService,
        request: Request,
        owner: u64,
        properties: Vec<serde_json::Map<String, Value>>,
    ) -> Value {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        service
            .submit_with_context(
                request,
                owner,
                0,
                properties,
                crate::wallpaper::references::Report::default(),
                move |value| {
                    send.send(value).unwrap();
                },
            )
            .unwrap();
        receive.recv_timeout(Duration::from_secs(10)).unwrap()
    }
    #[test]
    fn incremental_service_preserves_owner_properties_receipts_and_read_budget() {
        let root = tempfileish::temp_dir("service-large-playlist");
        let service = LibraryService::start(
            root.path().to_path_buf(),
            ProbeClient::testing(|_, _| Box::pin(async { Ok(()) })),
        );
        service.set_settings_owner(41);
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _entered = runtime.enter();
        let jobs = runtime.block_on(service.state.jobs()).unwrap();
        let published = runtime.block_on(async {
            let drafts = WorkDrafts::new(jobs.library());
            let draft = drafts
                .create(
                    serde_json::from_value::<Document>(
                        json!({"title":"分页服务","sceneId":"coast","stateVersion":1,"params":{}}),
                    )
                    .unwrap(),
                )
                .await
                .unwrap();
            drafts.save(&draft.id, draft.revision).await.unwrap();
            drafts
                .publish(&draft.id, draft.revision, jobs.assets())
                .await
                .unwrap()
        });
        call(
            &service,
            request("wake", "wallpaper.playlist.list", json!({"limit":20})),
            41,
            vec![],
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        while !service
            .state
            .initial_candidate_maintenance_complete
            .load(Ordering::Acquire)
        {
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(5));
        }
        let item = json!({"workKey":published.work_key,"packageHash":published.package_hash});
        let create = json!({"playlistId":"stable-id","expectedPlaylistRevision":0,"title":"服务增量","mode":"sequential","intervalSeconds":10,
            "operations":[{"kind":"insert","index":0,"item":item}]});
        let denied = call(
            &service,
            request("denied", "wallpaper.playlist.update", create.clone()),
            0,
            vec![],
        );
        assert_eq!(denied["error"]["code"], "settings_session_required");
        let first = call(
            &service,
            request("create", "wallpaper.playlist.update", create.clone()),
            41,
            vec![],
        );
        assert_eq!(first["ok"], true, "{first}");
        assert_eq!(first["result"]["itemCount"], 1);
        assert!(first["result"].get("items").is_none());
        assert_eq!(
            call(
                &service,
                request("create", "wallpaper.playlist.update", create.clone()),
                41,
                vec![]
            ),
            first
        );
        let recovered = call(
            &service,
            request(
                "recover",
                "wallpaper.operations.get",
                json!({"requestId":"create","command":"wallpaper.playlist.update"}),
            ),
            41,
            vec![],
        );
        assert_eq!(recovered["result"], first);
        let mut next = create.clone();
        next["expectedPlaylistRevision"] = 1.into();
        next["operations"] = json!([]);
        next["title"] = "拒绝的元数据".into();
        let denied_properties = call(
            &service,
            request("properties", "wallpaper.playlist.update", next),
            41,
            vec![json!({"unsupported":true}).as_object().unwrap().clone()],
        );
        assert_eq!(
            denied_properties["error"]["code"], "invalid_property_value",
            "{denied_properties}"
        );
        assert_eq!(
            runtime
                .block_on(
                    crate::wallpaper::playlist::Repository::new(jobs.library()).get("stable-id")
                )
                .unwrap()
                .revision,
            1
        );
        let mut second = create.clone();
        second["expectedPlaylistRevision"] = 1.into();
        second["operations"] = json!((1..=32)
            .map(|index| json!({"kind":"insert","index":index,"item":item}))
            .collect::<Vec<_>>());
        let accepted = call(
            &service,
            request("append", "wallpaper.playlist.update", second),
            41,
            vec![],
        );
        assert_eq!(accepted["result"]["itemCount"], 33, "{accepted}");
        assert_eq!(
            call(
                &service,
                request(
                    "old-get",
                    "wallpaper.playlist.get",
                    json!({"playlistId":"stable-id"})
                ),
                41,
                vec![]
            )["error"]["code"],
            "playlist_pagination_required"
        );
        for index in 0..300 {
            let value = call(
                &service,
                request(
                    &format!("page-{index}"),
                    "wallpaper.playlist.page",
                    json!({"playlistId":"stable-id","expectedPlaylistRevision":2,"offset":32,"limit":32}),
                ),
                41,
                vec![],
            );
            assert_eq!(
                value["result"]["items"].as_array().unwrap().len(),
                1,
                "{value}"
            );
        }
        assert!(service.state.history.lock().unwrap().len() < 30);
        let history = call(
            &service,
            request(
                "after-pages",
                "wallpaper.operations.get",
                json!({"requestId":"create","command":"wallpaper.playlist.update"}),
            ),
            41,
            vec![],
        );
        assert_eq!(history["result"], first);
    }
}
