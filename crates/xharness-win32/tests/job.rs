#![cfg(windows)]

use std::{
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use xharness_win32::Job;

#[test]
fn kill_on_close_job_accounts_for_and_terminates_a_process() {
    let job = Job::new_kill_on_close().expect("create Job Object");
    let mut child = Command::new("cmd.exe")
        .args(["/D", "/S", "/C", "ping -n 30 127.0.0.1 >NUL"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn test child");
    if let Err(error) = job.assign_pid(child.id()) {
        let _ = child.kill();
        panic!("assign child to Job Object: {error}");
    }

    assert!(job.accounting().unwrap().active_processes >= 1);
    job.terminate(91).expect("terminate Job Object");

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if child.try_wait().expect("inspect child").is_some() {
            break;
        }
        assert!(Instant::now() < deadline, "Job member did not terminate");
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(job.accounting().unwrap().active_processes, 0);
}
