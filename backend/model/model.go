package model

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Job tracks a single model download.
type Job struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	URL       string `json:"url"`
	Total     int64  `json:"total"`
	Current   int64  `json:"current"`
	Pct       int    `json:"pct"`
	Status    string `json:"status"` // downloading | completed | failed
	Error     string `json:"error,omitempty"`
	Filename  string `json:"filename"`
	updatedAt time.Time
}

// ModelInfo describes an installed model.
type ModelInfo struct {
	Name string `json:"name"`
	Size int64  `json:"size"`
	Path string `json:"path"`
}

// Manager handles model files and download jobs.
type Manager struct {
	dir       string
	jobs      map[string]*Job
	mu        sync.RWMutex
	client    *http.Client
	onChange  func() // called when a download completes (so caller can restart llama-server)
}

func NewManager(dir string) *Manager {
	return &Manager{
		dir: dir,
		jobs: make(map[string]*Job),
		client: &http.Client{
			Timeout: 0, // no timeout for large downloads
		},
	}
}

// SetOnChange registers a callback invoked after a download completes.
func (m *Manager) SetOnChange(fn func()) {
	m.onChange = fn
}

// List returns installed gguf models sorted by name.
func (m *Manager) List() ([]ModelInfo, error) {
	entries, err := os.ReadDir(m.dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var models []ModelInfo
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".gguf") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		models = append(models, ModelInfo{
			Name: strings.TrimSuffix(e.Name(), ".gguf"),
			Size: info.Size(),
			Path: filepath.Join(m.dir, e.Name()),
		})
	}
	sort.Slice(models, func(i, j int) bool { return models[i].Name < models[j].Name })
	return models, nil
}

// StartDownload begins an async download. Returns the job ID.
func (m *Manager) StartDownload(name, url, filename string) (string, error) {
	id := fmt.Sprintf("%d", time.Now().UnixNano())

	job := &Job{
		ID:       id,
		Name:     name,
		URL:      url,
		Status:   "downloading",
		Filename: filename,
	}

	m.mu.Lock()
	m.jobs[id] = job
	m.mu.Unlock()

	go m.doDownload(job)
	return id, nil
}

func (m *Manager) doDownload(job *Job) {
	dest := filepath.Join(m.dir, job.Filename)
	tmp := dest + ".tmp"

	os.MkdirAll(m.dir, 0755)
	os.Remove(tmp)

	// Probe: check whether server supports Range requests
	total, acceptRanges := m.probe(job.URL)
	if total <= 0 {
		m.failJob(job, "无法获取文件大小")
		return
	}

	job.Total = total
	job.updatedAt = time.Now()

	const workers = 8
	if acceptRanges && total > workers*4*1024*1024 {
		m.downloadChunked(job, tmp, workers)
	} else {
		m.downloadSingle(job, tmp)
	}

	if job.Status == "failed" {
		os.Remove(tmp)
		return
	}

	if err := os.Rename(tmp, dest); err != nil {
		m.failJob(job, "重命名失败: "+err.Error())
		return
	}

	m.mu.Lock()
	job.Status = "completed"
	job.Pct = 100
	job.Current = job.Total
	m.mu.Unlock()

	if m.onChange != nil {
		m.onChange()
	}
}

func (m *Manager) probe(url string) (size int64, acceptRanges bool) {
	req, _ := http.NewRequest("HEAD", url, nil)
	resp, err := m.client.Do(req)
	if err != nil {
		return 0, false
	}
	resp.Body.Close()
	return resp.ContentLength, resp.Header.Get("Accept-Ranges") == "bytes"
}

func (m *Manager) downloadSingle(job *Job, tmp string) {
	resp, err := m.client.Get(job.URL)
	if err != nil {
		m.failJob(job, "下载失败: "+err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		m.failJob(job, fmt.Sprintf("HTTP %d", resp.StatusCode))
		return
	}
	f, err := os.Create(tmp)
	if err != nil {
		m.failJob(job, "创建文件失败: "+err.Error())
		return
	}
	defer f.Close()
	pr := &progressReader{r: resp.Body, job: job, m: m}
	if _, err := io.Copy(f, pr); err != nil {
		m.failJob(job, "下载中断: "+err.Error())
	}
}

func (m *Manager) downloadChunked(job *Job, tmp string, workers int) {
	chunkSize := job.Total / int64(workers)
	var wg sync.WaitGroup
	errs := make([]error, workers)
	chunkFiles := make([]string, workers)

	f, err := os.Create(tmp)
	if err != nil {
		m.failJob(job, "创建文件失败: "+err.Error())
		return
	}
	defer f.Close()

	for i := 0; i < workers; i++ {
		start := int64(i) * chunkSize
		end := start + chunkSize - 1
		if i == workers-1 {
			end = job.Total - 1
		}
		chunkFiles[i] = tmp + fmt.Sprintf(".part%d", i)

		wg.Add(1)
		go func(idx int, rangeStart, rangeEnd int64) {
			defer wg.Done()
			errs[idx] = m.downloadChunk(job, chunkFiles[idx], rangeStart, rangeEnd)
		}(i, start, end)
	}

	wg.Wait()

	// Check errors
	for _, e := range errs {
		if e != nil {
			m.failJob(job, "分片下载失败: "+e.Error())
			return
		}
	}

	// Merge chunks in order
	for _, cf := range chunkFiles {
		chunk, err := os.ReadFile(cf)
		if err != nil {
			m.failJob(job, "读取分片失败: "+err.Error())
			return
		}
		if _, err := f.Write(chunk); err != nil {
			m.failJob(job, "合并分片失败: "+err.Error())
			return
		}
		os.Remove(cf)
	}
}

func (m *Manager) downloadChunk(job *Job, chunkFile string, start, end int64) error {
	req, _ := http.NewRequest("GET", job.URL, nil)
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", start, end))

	resp, err := m.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusPartialContent && resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}

	f, err := os.Create(chunkFile)
	if err != nil {
		return err
	}
	defer f.Close()

	pr := &progressReader{r: resp.Body, job: job, m: m}
	_, err = io.Copy(f, pr)
	return err
}

func (m *Manager) failJob(job *Job, errMsg string) {
	m.mu.Lock()
	job.Status = "failed"
	job.Error = errMsg
	m.mu.Unlock()
}

// Job returns a single job by ID.
func (m *Manager) Job(id string) *Job {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.jobs[id]
}

// Jobs returns all active/pending jobs. Completed/failed jobs older than 5 min are pruned.
func (m *Manager) Jobs() map[string]*Job {
	m.mu.Lock()
	defer m.mu.Unlock()
	cutoff := time.Now().Add(-5 * time.Minute)
	out := make(map[string]*Job)
	for id, j := range m.jobs {
		if (j.Status == "completed" || j.Status == "failed") && j.updatedAt.Before(cutoff) {
			delete(m.jobs, id)
			continue
		}
		out[id] = j
	}
	return out
}

// Delete removes a model file by display name.
func (m *Manager) Delete(name string) error {
	path := filepath.Join(m.dir, name+".gguf")
	if _, err := os.Stat(path); os.IsNotExist(err) {
		return fmt.Errorf("模型不存在")
	}
	return os.Remove(path)
}

// progressReader tracks download progress.
type progressReader struct {
	r       io.Reader
	job     *Job
	m       *Manager
	lastPct int
}

func (pr *progressReader) Read(p []byte) (int, error) {
	n, err := pr.r.Read(p)
	if n > 0 {
		pr.m.mu.Lock()
		pr.job.Current += int64(n)
		if pr.job.Total > 0 {
			pct := int(pr.job.Current * 100 / pr.job.Total)
			if pct != pr.lastPct {
				pr.job.Pct = pct
				pr.lastPct = pct
			}
		}
		pr.job.updatedAt = time.Now()
		pr.m.mu.Unlock()
	}
	return n, err
}
